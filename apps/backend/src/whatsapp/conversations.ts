import { prisma } from '@kda/db';

export interface ConversationHandle {
  conversationId: string;
  customerId: string;
  humanTakeover: boolean;
  humanTakeoverUntil: Date | null;
}

/**
 * Look up (or create) the customer + their active conversation for a given
 * WhatsApp number. Auto-expires `humanTakeover` if `humanTakeoverUntil` is
 * in the past so callers see the current effective state.
 */
export async function ensureConversationForNumber(
  whatsappNumber: string,
  contactName: string | null = null,
): Promise<ConversationHandle> {
  const customer = await prisma.customer.upsert({
    where: { whatsappNumber },
    create: { whatsappNumber, name: contactName },
    update: contactName ? { name: contactName } : {},
    select: { id: true },
  });

  const existing = await prisma.conversation.findFirst({
    where: { customerId: customer.id, state: { notIn: ['COMPLETED', 'ABANDONED'] } },
    orderBy: { lastInboundAt: 'desc' },
    select: { id: true, humanTakeover: true, humanTakeoverUntil: true },
  });

  if (existing) {
    const expired =
      existing.humanTakeover &&
      existing.humanTakeoverUntil !== null &&
      existing.humanTakeoverUntil <= new Date();
    if (expired) {
      await prisma.conversation.update({
        where: { id: existing.id },
        data: { humanTakeover: false, humanTakeoverUntil: null },
      });
      return {
        conversationId: existing.id,
        customerId: customer.id,
        humanTakeover: false,
        humanTakeoverUntil: null,
      };
    }
    return {
      conversationId: existing.id,
      customerId: customer.id,
      humanTakeover: existing.humanTakeover,
      humanTakeoverUntil: existing.humanTakeoverUntil,
    };
  }

  const created = await prisma.conversation.create({
    data: { customerId: customer.id },
    select: { id: true },
  });
  return {
    conversationId: created.id,
    customerId: customer.id,
    humanTakeover: false,
    humanTakeoverUntil: null,
  };
}

export function isTakeoverActive(c: Pick<ConversationHandle, 'humanTakeover' | 'humanTakeoverUntil'>): boolean {
  if (!c.humanTakeover) return false;
  if (c.humanTakeoverUntil === null) return true;
  return c.humanTakeoverUntil > new Date();
}
