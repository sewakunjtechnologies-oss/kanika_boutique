import { prisma } from '@kda/db';
import { env } from '../config/env';
import { logger } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { sendText } from '../whatsapp/client';

export function isSupportReply(text: string): 'CALL' | 'HELP' | null {
  const normalized = text.trim().toUpperCase();
  if (normalized === 'CALL') return 'CALL';
  if (normalized === 'HELP') return 'HELP';
  return null;
}

/**
 * Automated support follow-up is DISABLED. Per the approved policy the bot stays
 * silent after sending payment instructions until the customer replies — it must
 * never send a delayed Hindi/English "need help / Reply CALL / Reply HELP" nudge.
 * Kept as a no-op so the queue scheduler call site stays valid.
 */
export async function sendDueSupportNudges(_now: Date = new Date()): Promise<number> {
  return 0;
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
