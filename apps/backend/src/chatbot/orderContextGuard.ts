import { ConversationState, OrderStatus, prisma, type Conversation } from '@kda/db';
import type { OrderContext } from './stateMachine';

export type BotPausedReason = NonNullable<OrderContext['botPausedReason']>;

const HUMAN_TAKEOVER_MS = 6 * 60 * 60 * 1000;

const ACTIVE_CONTEXT_ORDER_STATUSES = new Set<OrderStatus>([
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_RECEIVED,
  OrderStatus.PAYMENT_REVIEW,
  OrderStatus.REJECTED,
]);

const CUSTOMER_CANCELLABLE_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_RECEIVED,
  OrderStatus.PAYMENT_REVIEW,
] as const;

export function readOrderContext(value: unknown): OrderContext {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as OrderContext;
  return {};
}

export function pausedContext(reason: BotPausedReason, previous?: OrderContext): OrderContext {
  return compactContext({
    botPausedReason: reason,
    productRejected: previous?.productRejected,
    lastMatchedProductRejected: previous?.lastMatchedProductRejected,
    lastImageUsable: previous?.lastImageUsable,
    awaitingNewProduct: previous?.awaitingNewProduct,
    rejectedProductId: previous?.rejectedProductId,
    lastRejectedProductId: previous?.lastRejectedProductId,
    rejectedImageMediaId: previous?.rejectedImageMediaId,
  });
}

export function hasBotPausedReason(value: unknown): boolean {
  return readOrderContext(value).botPausedReason !== undefined;
}

export function isOrderStatusActiveForConversation(status: OrderStatus): boolean {
  return ACTIVE_CONTEXT_ORDER_STATUSES.has(status);
}

export function stateRequiresPersistedOrder(state: ConversationState): boolean {
  return state === ConversationState.AWAITING_PAYMENT ||
    state === ConversationState.AWAITING_VERIFICATION;
}

export async function pauseConversationForBot(
  conversationId: string,
  reason: BotPausedReason,
): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      state: ConversationState.IDLE,
      contextJson: pausedContext(reason) as never,
      humanTakeover: true,
      humanTakeoverUntil: new Date(Date.now() + HUMAN_TAKEOVER_MS),
    },
  });
}

export async function pauseConversationsForOrder(
  customerId: string,
  orderId: string,
  reason: BotPausedReason,
): Promise<void> {
  const conversations = await prisma.conversation.findMany({
    where: { customerId },
    select: { id: true, contextJson: true },
  });

  await Promise.all(
    conversations
      .filter((conversation) => readOrderContext(conversation.contextJson).orderId === orderId)
      .map((conversation) => pauseConversationForBot(conversation.id, reason)),
  );
}

export async function cleanupStaleConversationOrderContexts(): Promise<{
  paused: number;
  cleared: number;
}> {
  const conversations = await prisma.conversation.findMany({
    where: { state: { notIn: [ConversationState.COMPLETED, ConversationState.ABANDONED] } },
    select: { id: true, customerId: true, state: true, contextJson: true },
    take: 500,
  });

  const orderIds = [
    ...new Set(
      conversations
        .map((conversation) => readOrderContext(conversation.contextJson).orderId)
        .filter((orderId): orderId is string => Boolean(orderId)),
    ),
  ];
  const orders = orderIds.length
    ? await prisma.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, customerId: true, status: true },
      })
    : [];
  const ordersById = new Map(orders.map((order) => [order.id, order]));

  let paused = 0;
  let cleared = 0;
  for (const conversation of conversations) {
    if (hasBotPausedReason(conversation.contextJson)) continue;

    const ctx = readOrderContext(conversation.contextJson);
    if (stateRequiresPersistedOrder(conversation.state) && !ctx.orderId) {
      await pauseConversationForBot(conversation.id, 'stale_order');
      paused += 1;
      continue;
    }

    if (!ctx.orderId) continue;

    const order = ordersById.get(ctx.orderId);
    if (!order || order.customerId !== conversation.customerId) {
      await pauseConversationForBot(conversation.id, 'stale_order');
      paused += 1;
      continue;
    }

    if (order.status === OrderStatus.CANCELLED) {
      await pauseConversationForBot(conversation.id, 'order_closed');
      paused += 1;
      continue;
    }

    if (!isOrderStatusActiveForConversation(order.status)) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { state: ConversationState.IDLE, contextJson: {} },
      });
      cleared += 1;
    }
  }

  return { paused, cleared };
}

export async function cancelContextOrderIfAllowed(
  conversation: Pick<Conversation, 'id' | 'contextJson'>,
): Promise<{ orderId: string | null; cancelled: boolean }> {
  const ctx = readOrderContext(conversation.contextJson);
  let cancelled = false;
  if (ctx.orderId) {
    const result = await prisma.order.updateMany({
      where: {
        id: ctx.orderId,
        status: { in: [...CUSTOMER_CANCELLABLE_STATUSES] },
      },
      data: {
        status: OrderStatus.CANCELLED,
        notes: 'Cancelled from WhatsApp conversation.',
      },
    });
    cancelled = result.count > 0;
  }
  return { orderId: ctx.orderId ?? null, cancelled };
}

export function clearPausedContextOnRelease(
  contextJson: unknown,
): { state?: ConversationState; contextJson?: OrderContext } {
  if (!hasBotPausedReason(contextJson)) return {};
  return { state: ConversationState.IDLE, contextJson: {} };
}

function compactContext(context: OrderContext): OrderContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as OrderContext;
}
