import { ConversationState, prisma } from '@kda/db';
import { env } from '../config/env';
import { logger } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { sendText } from '../whatsapp/client';

export const SUPPORT_NUDGE_MESSAGE = [
  'Need help completing your order?',
  '',
  'Agar aap order complete nahi kar paa rahe hain, boutique team aapki help kar sakti hai.',
  '',
  'You can call us or we can call you.',
  'Reply CALL for callback or HELP for support.',
].join('\n');

const WAITING_STATES: ConversationState[] = [
  ConversationState.AWAITING_PRODUCT_CONFIRMATION,
  ConversationState.AWAITING_NEW_PRODUCT,
  ConversationState.AWAITING_SIZE,
  ConversationState.AWAITING_QTY,
  ConversationState.AWAITING_NAME,
  ConversationState.AWAITING_ADDRESS,
  ConversationState.AWAITING_PINCODE,
  ConversationState.AWAITING_PAYMENT,
  ConversationState.AWAITING_VERIFICATION,
];

export function isSupportReply(text: string): 'CALL' | 'HELP' | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === 'CALL') return 'CALL';
  if (normalized === 'HELP') return 'HELP';
  return null;
}

export async function sendDueSupportNudges(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - env.SUPPORT_NUDGE_DELAY_MINUTES * 60 * 1000);
  const candidates = await prisma.conversation.findMany({
    where: {
      state: { in: WAITING_STATES },
      humanTakeover: false,
      supportNudgeSentAt: null,
      lastOutboundAt: { lte: cutoff },
    },
    include: { customer: { select: { whatsappNumber: true } } },
    take: 100,
  });

  let sent = 0;
  for (const conv of candidates) {
    if (
      !shouldSendSupportNudge({
        lastInboundAt: conv.lastInboundAt,
        lastOutboundAt: conv.lastOutboundAt,
        supportNudgeSentAt: conv.supportNudgeSentAt,
        now,
        delayMinutes: env.SUPPORT_NUDGE_DELAY_MINUTES,
      })
    ) continue;
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { supportNudgeSentAt: now },
    });
    try {
      const outcome = await sendText(conv.customer.whatsappNumber, SUPPORT_NUDGE_MESSAGE);
      if (outcome.ok) sent += 1;
    } catch (err) {
      logger.warn({ err, conversationId: conv.id }, 'support nudge send failed');
    }
  }
  return sent;
}

export function shouldSendSupportNudge(input: {
  lastInboundAt: Date;
  lastOutboundAt: Date | null;
  supportNudgeSentAt: Date | null;
  now: Date;
  delayMinutes: number;
}): boolean {
  if (input.supportNudgeSentAt) return false;
  if (!input.lastOutboundAt) return false;
  if (input.lastInboundAt >= input.lastOutboundAt) return false;
  const cutoff = new Date(input.now.getTime() - input.delayMinutes * 60 * 1000);
  return input.lastOutboundAt <= cutoff;
}

export async function handleSupportReply(input: {
  conversationId: string;
  customerWhatsappNumber: string;
  text: string;
}): Promise<boolean> {
  const reply = isSupportReply(input.text);
  if (!reply) return false;

  const now = new Date();
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      supportRequestedAt: now,
      humanTakeover: true,
      humanTakeoverUntil: new Date(now.getTime() + 6 * 60 * 60 * 1000),
    },
  });
  emitToDashboard('support_requested', { conversationId: input.conversationId, type: reply });
  emitToDashboard('takeover_changed', { conversationId: input.conversationId, humanTakeover: true });

  if (reply === 'CALL') {
    await notifySupportNumber(
      `Customer requested callback for WhatsApp order support: ${input.customerWhatsappNumber}`,
    );
    await sendText(
      input.customerWhatsappNumber,
      'Got it. The boutique team will call you soon. Bot is paused now.',
      { ignoreTakeover: true },
    );
  } else {
    await notifySupportNumber(
      `Customer requested WhatsApp support: ${input.customerWhatsappNumber}`,
    );
    await sendText(
      input.customerWhatsappNumber,
      'Got it. The boutique team will help you here. Bot is paused now.',
      { ignoreTakeover: true },
    );
  }
  return true;
}

async function notifySupportNumber(body: string): Promise<void> {
  const to = (env.SUPPORT_PHONE_NUMBER || env.OWNER_WHATSAPP_NUMBER).replace(/[^\d]/g, '');
  if (!to) {
    logger.warn('support requested but SUPPORT_PHONE_NUMBER/OWNER_WHATSAPP_NUMBER is not configured');
    return;
  }
  try {
    await sendText(to, body, { ignoreTakeover: true });
  } catch (err) {
    logger.warn({ err }, 'support owner notification failed');
  }
}
