import { prisma, MessageDirection, MessageType, Prisma } from '@kda/db';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { botError, botLog, logger } from '../logger';
import { handleInboundMessage } from '../chatbot/orchestrator';
import { emitToDashboard } from '../realtime/io';
import { redisConnection } from '../queues/connection';
import {
  isHistoryValue,
  isMessagesValue,
  isSmbAppStateSyncValue,
  isSmbMessageEchoesValue,
  type Contact,
  type HistoryMessage,
  type IncomingMessage,
  type SmbEchoMessage,
  type WebhookChange,
  type WebhookPayload,
} from './types';

const HUMAN_TAKEOVER_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours

// =============================================================================
// Entry point — called by the BullMQ worker
// =============================================================================

export async function processWebhookEvent(payload: WebhookPayload): Promise<void> {
  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  if (entries.length === 0) {
    logger.debug({ payload }, 'webhook payload has no entries');
    return;
  }

  for (const entry of entries) {
    for (const change of entry.changes ?? []) {
      await routeChange(change);
    }
  }
}

async function routeChange(change: WebhookChange): Promise<void> {
  const { field, value } = change;
  botLog('WEBHOOK_CHANGE_RECEIVED', { field });

  try {
    if (isMessagesValue(field, value)) {
      await handleMessagesValue(value);
    } else if (isSmbMessageEchoesValue(field, value)) {
      await handleSmbMessageEchoes(value);
    } else if (isSmbAppStateSyncValue(field, value)) {
      await handleSmbAppStateSync(value);
    } else if (isHistoryValue(field, value)) {
      await handleHistory(value);
    } else {
      logger.debug({ field }, 'unhandled webhook field');
    }
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'process_webhook_change', field });
    throw err; // let BullMQ retry
  }
}

// =============================================================================
// Inbound customer messages
// =============================================================================

async function handleMessagesValue(value: import('./types').MessagesValue): Promise<void> {
  // Index contact profiles by wa_id so we can capture names on first contact.
  const contactsByWaId = indexContacts(value.contacts);

  for (const msg of value.messages ?? []) {
    await persistInboundMessage(msg, contactsByWaId.get(msg.from)?.profile?.name ?? null);
  }

  for (const status of value.statuses ?? []) {
    logger.debug({ id: status.id, status: status.status }, 'message status update');
  }
}

async function persistInboundMessage(msg: IncomingMessage, contactName: string | null): Promise<void> {
  const customer = await upsertCustomer(msg.from, contactName);
  const conversation = await getOrCreateConversation(customer.id);

  const { type, content, mediaUrl } = extractMessageContent(msg);
  botLog('MESSAGE_TYPE_DETECTED', {
    from: msg.from,
    messageId: msg.id,
    type: msg.type,
    mappedType: type,
    conversationId: conversation.id,
  });
  if (msg.type === 'text') {
    botLog('TEXT_EXTRACTED', {
      from: msg.from,
      messageId: msg.id,
      text: msg.text.body.slice(0, 500),
    });
  } else if (msg.type === 'image') {
    botLog('IMAGE_MEDIA_ID_FOUND', {
      from: msg.from,
      messageId: msg.id,
      mediaId: msg.image.id,
      mimeType: msg.image.mime_type,
      hasCaption: Boolean(msg.image.caption),
    });
  }

  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        messageType: type,
        content,
        mediaUrl,
        whatsappMessageId: msg.id,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastInboundAt: new Date() },
    });
    logger.info(
      { from: msg.from, type, conversationId: conversation.id, wamid: msg.id },
      'inbound message stored',
    );
    emitToDashboard('message', {
      conversationId: conversation.id,
      direction: 'INBOUND',
      messageId: msg.id,
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      logger.debug({ wamid: msg.id }, 'duplicate inbound message — skipping');
      return;
    }
    throw err;
  }

  // Hand off to orchestrator (intent classification + state machine). The lock
  // keeps rapid replies from the same customer in state order across workers.
  try {
    await withConversationProcessingLock(conversation.id, async () => {
      await handleInboundMessage({
        conversationId: conversation.id,
        customerId: customer.id,
        customerWhatsappNumber: msg.from,
        message: msg,
      });
    });
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'orchestrator', wamid: msg.id });
  }
}

// =============================================================================
// Owner's manual replies (Coexistence smb_message_echoes)
// =============================================================================

async function handleSmbMessageEchoes(value: import('./types').SmbMessageEchoesValue): Promise<void> {
  for (const echo of value.message_echoes ?? []) {
    await persistEchoMessage(echo);
  }
}

async function persistEchoMessage(echo: SmbEchoMessage): Promise<void> {
  // The customer is `echo.to`; the owner is the WABA number.
  const customer = await upsertCustomer(echo.to, null);
  const conversation = await getOrCreateConversation(customer.id);

  const { type, content, mediaUrl } = extractMessageContent(echo);
  const takeoverUntil = new Date(Date.now() + HUMAN_TAKEOVER_DURATION_MS);

  try {
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND_OWNER_MANUAL,
        messageType: type,
        content,
        mediaUrl,
        whatsappMessageId: echo.id,
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        humanTakeover: true,
        humanTakeoverUntil: takeoverUntil,
        lastOutboundAt: new Date(),
      },
    });
    logger.info(
      {
        to: echo.to,
        type,
        conversationId: conversation.id,
        wamid: echo.id,
        humanTakeoverUntil: takeoverUntil.toISOString(),
      },
      'owner echo stored, human takeover engaged',
    );
    emitToDashboard('message', {
      conversationId: conversation.id,
      direction: 'OUTBOUND_OWNER_MANUAL',
      messageId: echo.id,
    });
    emitToDashboard('takeover_changed', { conversationId: conversation.id, humanTakeover: true });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      logger.debug({ wamid: echo.id }, 'duplicate echo — skipping');
      return;
    }
    throw err;
  }
}

// =============================================================================
// Owner's contact sync (Coexistence smb_app_state_sync)
// =============================================================================

async function handleSmbAppStateSync(value: import('./types').SmbAppStateSyncValue): Promise<void> {
  let added = 0;
  let updated = 0;
  for (const sync of value.state_sync ?? []) {
    if (sync.type !== 'contact' || !sync.contact?.phone_number) continue;
    const name =
      sync.contact.full_name ?? sync.contact.first_name ?? null;
    const result = await prisma.customer.upsert({
      where: { whatsappNumber: sync.contact.phone_number },
      create: { whatsappNumber: sync.contact.phone_number, name },
      update: name ? { name } : {},
    });
    if (result.createdAt.getTime() > Date.now() - 5000) added += 1;
    else updated += 1;
  }
  if (added || updated) {
    logger.info({ added, updated }, 'smb_app_state_sync contacts processed');
  }
}

// =============================================================================
// One-time history dump (Coexistence history)
// =============================================================================

async function handleHistory(value: import('./types').HistoryValue): Promise<void> {
  for (const block of value.history ?? []) {
    // Newer shape: threads[]
    for (const thread of block.threads ?? []) {
      const customer = await upsertCustomer(thread.id, thread.contact?.name ?? null);
      const conversation = await getOrCreateConversation(customer.id);
      await bulkInsertHistoryMessages(conversation.id, thread.messages ?? []);
    }
    // Older flat shape: contacts[] + messages[]
    if (block.messages?.length) {
      const contactsByWaId = indexContacts(block.contacts);
      const groupedByWaId = new Map<string, HistoryMessage[]>();
      for (const m of block.messages) {
        const waId = m.from_me ? m.to : m.from;
        if (!waId) continue;
        const existing = groupedByWaId.get(waId);
        if (existing) existing.push(m);
        else groupedByWaId.set(waId, [m]);
      }
      for (const [waId, msgs] of groupedByWaId) {
        const customer = await upsertCustomer(
          waId,
          contactsByWaId.get(waId)?.profile?.name ?? null,
        );
        const conversation = await getOrCreateConversation(customer.id);
        await bulkInsertHistoryMessages(conversation.id, msgs);
      }
    }
  }
}

async function bulkInsertHistoryMessages(
  conversationId: string,
  messages: HistoryMessage[],
): Promise<void> {
  if (!messages.length) return;
  const rows = messages.map((m) => {
    const { type, content, mediaUrl } = extractMessageContent(m);
    return {
      conversationId,
      direction: m.from_me ? MessageDirection.OUTBOUND_OWNER_MANUAL : MessageDirection.INBOUND,
      messageType: type,
      content,
      mediaUrl,
      whatsappMessageId: m.id,
      createdAt: parseTimestamp(m.timestamp),
    };
  });
  const result = await prisma.message.createMany({
    data: rows,
    skipDuplicates: true,
  });
  logger.info({ conversationId, requested: rows.length, inserted: result.count }, 'history messages bulk-inserted');
}

// =============================================================================
// Helpers
// =============================================================================

function indexContacts(contacts: Contact[] | undefined): Map<string, Contact> {
  const map = new Map<string, Contact>();
  for (const c of contacts ?? []) map.set(c.wa_id, c);
  return map;
}

async function upsertCustomer(
  whatsappNumber: string,
  name: string | null,
): Promise<{ id: string; createdAt: Date }> {
  return prisma.customer.upsert({
    where: { whatsappNumber },
    create: { whatsappNumber, name },
    update: name ? { name } : {},
    select: { id: true, createdAt: true },
  });
}

async function getOrCreateConversation(customerId: string): Promise<{ id: string }> {
  const existing = await prisma.conversation.findFirst({
    where: { customerId, state: { notIn: ['COMPLETED', 'ABANDONED'] } },
    orderBy: { lastInboundAt: 'desc' },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: { customerId },
    select: { id: true },
  });
}

function extractMessageContent(
  msg: IncomingMessage | SmbEchoMessage | HistoryMessage,
): { type: MessageType; content: string | null; mediaUrl: string | null } {
  switch (msg.type) {
    case 'text':
      return { type: MessageType.TEXT, content: msg.text.body, mediaUrl: null };
    case 'image':
      return { type: MessageType.IMAGE, content: msg.image.caption ?? null, mediaUrl: msg.image.id };
    case 'audio':
      return { type: MessageType.AUDIO, content: null, mediaUrl: msg.audio.id };
    case 'video':
      return { type: MessageType.VIDEO, content: msg.video.caption ?? null, mediaUrl: msg.video.id };
    case 'document':
      return {
        type: MessageType.DOCUMENT,
        content: msg.document.filename ?? msg.document.caption ?? null,
        mediaUrl: msg.document.id,
      };
    case 'location':
      return {
        type: MessageType.LOCATION,
        content: JSON.stringify(msg.location),
        mediaUrl: null,
      };
    case 'interactive': {
      const i = msg.interactive;
      if (i.type === 'button_reply') {
        return {
          type: MessageType.INTERACTIVE_BUTTON,
          content: `${i.button_reply.id}|${i.button_reply.title}`,
          mediaUrl: null,
        };
      }
      return {
        type: MessageType.INTERACTIVE_LIST,
        content: `${i.list_reply.id}|${i.list_reply.title}`,
        mediaUrl: null,
      };
    }
    case 'button':
      return { type: MessageType.INTERACTIVE_BUTTON, content: msg.button.text, mediaUrl: null };
    case 'sticker':
    case 'reaction':
    case 'order':
    case 'system':
    case 'contacts':
    case 'unsupported':
    default:
      return { type: MessageType.UNKNOWN, content: null, mediaUrl: null };
  }
}

function parseTimestamp(ts: string): Date {
  const seconds = Number.parseInt(ts, 10);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000);
  return new Date();
}

function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

async function withConversationProcessingLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `lock:conversation:${conversationId}`;
  const token = randomUUID();
  const ttlMs = 120_000;

  for (let attempt = 0; attempt < 130; attempt += 1) {
    const acquired = await redisConnection.set(key, token, 'PX', ttlMs, 'NX');
    if (acquired === 'OK') {
      try {
        return await fn();
      } finally {
        const current = await redisConnection.get(key);
        if (current === token) await redisConnection.del(key);
      }
    }
    await sleep(1000);
  }

  throw new Error(`timed out waiting for conversation lock ${conversationId}`);
}
