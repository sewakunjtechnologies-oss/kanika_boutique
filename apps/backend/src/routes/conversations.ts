import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, ConversationState, MessageDirection } from '@kda/db';
import { requireAuth } from '../auth/middleware';
import { sendTemplate, sendText } from '../whatsapp/client';
import { logger } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { clearPausedContextOnRelease, readOrderContext } from '../chatbot/orderContextGuard';
import { startFreshOrderFromConversationImage } from '../chatbot/orchestrator';

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

const TAKEOVER_DEFAULT_MS = 6 * 60 * 60 * 1000;

conversationsRouter.get('/conversations', async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10) || 100, 200);
  const list = await prisma.conversation.findMany({
    include: {
      customer: { select: { id: true, name: true, whatsappNumber: true } },
      messages: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { content: true, messageType: true, direction: true, createdAt: true },
      },
    },
    orderBy: { lastInboundAt: 'desc' },
    take: limit,
  });
  res.json({ conversations: list });
});

conversationsRouter.get(
  '/conversations/:id/messages',
  async (req: Request, res: Response): Promise<void> => {
    const conv = await prisma.conversation.findUnique({
      where: { id: (req.params.id as string) },
      include: { customer: { select: { id: true, name: true, whatsappNumber: true } } },
    });
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const messages = await prisma.message.findMany({
      where: { conversationId: (req.params.id as string) },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    res.json({ conversation: conv, messages });
  },
);

const TakeoverSchema = z.object({
  active: z.boolean(),
  durationMs: z.number().int().positive().optional(),
});

conversationsRouter.post(
  '/conversations/:id/takeover',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TakeoverSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const until = parsed.data.active
      ? new Date(Date.now() + (parsed.data.durationMs ?? TAKEOVER_DEFAULT_MS))
      : null;
    const conversation = await prisma.conversation.findUnique({
      where: { id: (req.params.id as string) },
      select: { contextJson: true },
    });
    const releaseCleanup = parsed.data.active || !conversation
      ? {}
      : clearPausedContextOnRelease(conversation.contextJson);
    await prisma.conversation.update({
      where: { id: (req.params.id as string) },
      data: {
        humanTakeover: parsed.data.active,
        humanTakeoverUntil: until,
        ...releaseCleanup,
      } as never,
    });
    emitToDashboard('takeover_changed', {
      conversationId: (req.params.id as string),
      humanTakeover: parsed.data.active,
    });
    res.json({ ok: true });
  },
);

conversationsRouter.post(
  '/conversations/:id/resume-bot',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      select: { contextJson: true },
    });
    if (!conversation) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const releaseCleanup = clearPausedContextOnRelease(conversation.contextJson);
    await prisma.conversation.update({
      where: { id },
      data: {
        state: ConversationState.IDLE,
        humanTakeover: false,
        humanTakeoverUntil: null,
        contextJson: releaseCleanup.contextJson ?? {},
      } as never,
    });
    emitToDashboard('takeover_changed', { conversationId: id, humanTakeover: false });
    res.json({ ok: true });
  },
);

conversationsRouter.post(
  '/conversations/:id/pause-bot',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    await prisma.conversation.update({
      where: { id },
      data: {
        humanTakeover: true,
        humanTakeoverUntil: new Date(Date.now() + TAKEOVER_DEFAULT_MS),
      },
    });
    emitToDashboard('takeover_changed', { conversationId: id, humanTakeover: true });
    res.json({ ok: true });
  },
);

const MuteSchema = z.object({ muted: z.boolean() });

// Owner "Mute bot" toggle — permanent human-takeover for a contact (e.g. a
// supplier). While muted the bot does zero processing; unmuting restores normal
// flow. Persisted on the Conversation record (visible in the list).
conversationsRouter.post(
  '/conversations/:id/mute',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = MuteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const id = req.params.id as string;
    await prisma.conversation.update({
      where: { id },
      data: { botMuted: parsed.data.muted },
    });
    emitToDashboard('takeover_changed', { conversationId: id, botMuted: parsed.data.muted });
    res.json({ ok: true, botMuted: parsed.data.muted });
  },
);

conversationsRouter.post(
  '/conversations/:id/start-new-order-from-last-image',
  async (req: Request, res: Response): Promise<void> => {
    const result = await startFreshOrderFromConversationImage(req.params.id as string);
    if (!result.ok) {
      res.status(result.reason === 'conversation_not_found' ? 404 : 409).json({ error: result.reason ?? 'failed' });
      return;
    }
    emitToDashboard('takeover_changed', {
      conversationId: req.params.id as string,
      humanTakeover: false,
      startedFromLastImage: true,
    });
    res.json({ ok: true });
  },
);

conversationsRouter.post(
  '/conversations/:id/mark-resolved',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    const conversation = await prisma.conversation.findUnique({
      where: { id },
      select: { contextJson: true },
    });
    if (!conversation) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await prisma.conversation.update({
      where: { id },
      data: {
        state: ConversationState.COMPLETED,
        humanTakeover: false,
        humanTakeoverUntil: null,
        contextJson: {
          ...readOrderContext(conversation.contextJson),
          resolvedAt: new Date().toISOString(),
        } as never,
      },
    });
    emitToDashboard('takeover_changed', { conversationId: id, resolved: true });
    res.json({ ok: true });
  },
);

const ReplySchema = z.object({ body: z.string().min(1).max(4096) });

conversationsRouter.post(
  '/conversations/:id/manual-reply',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = ReplySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: (req.params.id as string) },
      include: { customer: { select: { whatsappNumber: true } } },
    });
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    // Send via Meta. The wamid we get back is stored as OUTBOUND_BOT here
    // since the bot framework is the actual sender (it just relays the
    // human's typed text). The dashboard labels it as "you (via dashboard)".
    try {
      const result = await sendText(conv.customer.whatsappNumber, parsed.data.body, {
        ignoreTakeover: true,
      });
      if (result.ok) {
        await prisma.conversation.update({
          where: { id: (req.params.id as string) },
          data: {
            humanTakeover: true,
            humanTakeoverUntil: new Date(Date.now() + TAKEOVER_DEFAULT_MS),
          },
        });
        // Update direction post-create — we want this labeled OUTBOUND_OWNER_MANUAL.
        const messageId = await idForWamid(result.wamid);
        if (messageId) {
          await prisma.message.update({
            where: { id: messageId },
            data: { direction: MessageDirection.OUTBOUND_OWNER_MANUAL },
          });
        } else {
          logger.warn({ wamid: result.wamid }, 'manual reply sent but outbound message row was not found');
        }
        emitToDashboard('message', {
          conversationId: (req.params.id as string),
          direction: 'OUTBOUND_OWNER_MANUAL',
          messageId: result.wamid,
        });
        res.json({ ok: true, wamid: result.wamid });
        return;
      }
      res.status(502).json({ error: result.reason, detail: result.detail });
    } catch (err) {
      logger.error({ err }, 'manual reply send failed');
      res.status(500).json({ error: 'send_failed' });
    }
  },
);

async function idForWamid(wamid: string): Promise<string | null> {
  const m = await prisma.message.findUnique({ where: { whatsappMessageId: wamid } });
  return m?.id ?? null;
}

// =============================================================================
// DELETE — cascades to messages (per schema). The customer + their orders stay.
// =============================================================================
conversationsRouter.delete(
  '/conversations/:id',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params.id as string;
    try {
      await prisma.conversation.delete({ where: { id } });
      emitToDashboard('takeover_changed', { conversationId: id, deleted: true });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, id }, 'conversation delete failed');
      res.status(500).json({ error: 'delete_failed' });
    }
  },
);

// =============================================================================
// Send an approved template — the only way to (re-)open a conversation after
// the 24h customer-service window has closed (free-form sends get rejected by
// Meta with error 131047 once 24h pass since the last inbound message).
// =============================================================================

const TemplateSchema = z.object({
  templateName: z.string().min(1),
  languageCode: z.string().min(2).default('en'),
  // Optional Meta template components (header/body params, buttons). Pass-through.
  components: z.array(z.unknown()).optional(),
});

conversationsRouter.post(
  '/conversations/:id/send-template',
  async (req: Request, res: Response): Promise<void> => {
    const parsed = TemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
      return;
    }
    const conv = await prisma.conversation.findUnique({
      where: { id: req.params.id as string },
      include: { customer: { select: { whatsappNumber: true } } },
    });
    if (!conv) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    try {
      const result = await sendTemplate(
        conv.customer.whatsappNumber,
        parsed.data.templateName,
        parsed.data.languageCode,
        parsed.data.components ?? [],
      );
      if (result.ok) {
        emitToDashboard('message', {
          conversationId: req.params.id as string,
          direction: 'OUTBOUND_BOT',
          messageId: result.wamid,
        });
        res.json({ ok: true, wamid: result.wamid });
        return;
      }
      res.status(502).json({ error: result.reason, detail: result.detail });
    } catch (err) {
      logger.error({ err }, 'send-template failed');
      res.status(500).json({ error: 'send_failed' });
    }
  },
);
