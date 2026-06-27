import { prisma, ConversationState, Intent, MessageType, OrderStatus, Prisma, type Conversation } from '@kda/db';
import { botError, botLog, logger } from '../logger';
import {
  classifyCustomerIntent,
  classifyIntent,
  detectCustomerIntent,
  type CustomerIntentInput,
} from '../ai/intentClassifier';
import { matchProduct, type ProductMatchCandidate, type ProductMatchOutcome } from '../ai/productMatcher';
import { extractPayment } from '../ai/paymentExtractor';
import { downloadMedia, sendInteractiveButtons, sendInteractiveList, sendText } from '../whatsapp/client';
import { notifyAdminsPaymentPending, shouldSendAdminNotification } from '../whatsapp/adminNotifications';
import { isTakeoverActive } from '../whatsapp/conversations';
import { storage } from '../storage';
import { env } from '../config/env';
import {
  isAmbiguousCancelIntent,
  isDirectCancelIntent,
  isProductChangeIntent,
  PRODUCT_REJECTED_MESSAGE,
  PRODUCT_FIRST_MESSAGE,
  CHECKING_PRODUCT_MESSAGE,
  transition,
  type Action,
  type ChatEvent,
  type OrderContext,
} from './stateMachine';
import {
  checkStock,
  createOrderFromContext,
  getProductAvailability,
  suggestAlternatives,
} from './orderService';
import { emitToDashboard } from '../realtime/io';
import type { IncomingMessage } from '../whatsapp/types';
import fs from 'node:fs/promises';
import { getBusinessSettings } from '../settings/businessSettings';
import { getPaymentReviewWarnings } from './paymentSafety';
import {
  cancelContextOrderIfAllowed,
  hasBotPausedReason,
  isOrderStatusActiveForConversation,
  pausedContext,
  pauseConversationForBot,
  readOrderContext,
  stateRequiresPersistedOrder,
} from './orderContextGuard';
import {
  canUseConversationImageForRestart,
  classifyPausedDecision,
  hasReusablePendingRestart,
  RESUME_CONFIRMATION_MESSAGE,
  UNMATCHED_IMAGE_REPLY,
} from './pausedResume';
import { handleSupportReply } from './supportNudge';

const HUMAN_TAKEOVER_MS = 6 * 60 * 60 * 1000;
const NEW_PRODUCT_AFTER_CANCEL_MESSAGE = 'Sure. Please send the new product photo or article number.';

interface OrchestratorInput {
  conversationId: string;
  customerId: string;
  customerWhatsappNumber: string;
  message: IncomingMessage;
}

/**
 * Main entry point — called by messageProcessor after an inbound message is
 * stored. Handles intent classification, takeover, state machine, action exec.
 */
export async function handleInboundMessage(input: OrchestratorInput): Promise<void> {
  let conv = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
  });
  if (!conv) {
    logger.warn({ conversationId: input.conversationId }, 'orchestrator: conversation not found');
    return;
  }

  const event = await messageToEvent(input.message);

  if (event.type === 'TEXT') {
    const supportHandled = await handleSupportReply({
      conversationId: input.conversationId,
      customerWhatsappNumber: input.customerWhatsappNumber,
      text: event.body,
    });
    if (supportHandled) return;
  }

  // 1. Takeover guard — auto-expire if past humanTakeoverUntil.
  if (isTakeoverActive(conv)) {
    if (hasBotPausedReason(conv.contextJson)) {
      const handled = await handlePausedConversationInput(input, conv, event);
      if (handled) return;
      logger.info({ conversationId: conv.id }, 'orchestrator: bot paused after order closure/cancel, skipping');
      return;
    }
    const takeoverDecision = await resolveTakeoverForTrigger(input, conv, event);
    if (takeoverDecision === 'skip') {
      logger.info({ conversationId: conv.id }, 'orchestrator: takeover active, skipping bot');
      return;
    }
    if (takeoverDecision === 'handled') return;
    conv = { ...conv, humanTakeover: false, humanTakeoverUntil: null };
  }
  if (conv.humanTakeover && conv.humanTakeoverUntil && conv.humanTakeoverUntil <= new Date()) {
    const contextJson = hasBotPausedReason(conv.contextJson) ? {} : conv.contextJson;
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { humanTakeover: false, humanTakeoverUntil: null, contextJson: contextJson as never },
    });
    conv = { ...conv, humanTakeover: false, humanTakeoverUntil: null, contextJson: contextJson as never };
  }

  const reconciled = await reconcileOrderContextBeforeTurn(input, conv);
  conv = reconciled.conversation;
  if (reconciled.stop) return;

  // 2. Audio / voice notes are always PERSONAL_CHAT — short-circuit before AI.
  if (input.message.type === 'audio') {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { intent: Intent.PERSONAL_CHAT },
    });
    logger.info({ conversationId: conv.id }, 'audio message — treating as PERSONAL_CHAT, no bot reply');
    return;
  }

  // 3. Intent classification. Once a customer is inside an order flow, short
  // answers like "2" or "M" must be handled by the state machine instead of
  // being dropped by generic intent classification.
  let intent: Intent = Intent.UNKNOWN;
  const deterministicIntent = isActiveOrderState(conv.state)
    ? Intent.ORDER_INTENT
    : detectDeterministicIntent(input.message, {
        conversationId: conv.id,
        senderLast4: last4(input.customerWhatsappNumber),
      });
  if (deterministicIntent) {
    intent = deterministicIntent;
    botLog('INTENT_DETECTED', {
      conversationId: conv.id,
      intent,
      source: isActiveOrderState(conv.state) ? 'active_order_state' : 'deterministic',
    });
  } else if (env.GEMINI_API_KEY) {
    try {
      const intentInput = await buildIntentInput(input.message);
      const r = await classifyIntent(intentInput);
      intent = r.intent as Intent;
      botLog('INTENT_DETECTED', {
        conversationId: conv.id,
        intent: r.intent,
        confidence: r.confidence,
        source: 'gemini',
      });
    } catch (err) {
      botError('ERROR_DETAILS', err, { step: 'intent_classification' });
      intent = Intent.UNKNOWN;
    }
  } else {
    logger.warn('GEMINI_API_KEY not set and no deterministic intent matched');
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: { intent },
  });

  if (intent !== Intent.ORDER_INTENT) {
    logger.info(
      { conversationId: conv.id, intent },
      intent === Intent.PERSONAL_CHAT ? 'ignored casual message' : 'Ignored non-intent message',
    );
    return;
  }

  const catalogOptionsHandled = await handleCatalogOptionsIntent(input, conv, event);
  if (catalogOptionsHandled) return;

  const statePriorityHandled = await handleStatePriorityInput(input, conv, event);
  if (statePriorityHandled) return;

  // 4. Handle FAQs/cross-questions before asking the state machine to consume
  // the message as the next order answer.
  const questionHandled = await handleQuestion(input, conv, event);
  if (questionHandled) return;

  const productConfirmationHandled = await handleProductConfirmationInput(input, conv, event);
  if (productConfirmationHandled) return;

  if (conv.state === ConversationState.IDLE) {
    const handled = await handleIdleCatalogInquiry(input, event);
    if (handled) return;
  }

  // 5. Run state machine.
  let result = transition(conv.state, event, (conv.contextJson as OrderContext) ?? {});
  result = await executeActions(input, conv, result);

  // 6. Persist state + context.
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { state: result.nextState, contextJson: result.context as never },
  });
}

async function handlePausedConversationInput(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  const ctx = readOrderContext(conv.contextJson);
  const decision = classifyPausedDecision(event, ctx);

  if (decision === 'ignore') return true;

  if (decision === 'attention') {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        contextJson: {
          ...ctx,
          attentionRequestedAt: new Date().toISOString(),
        } as never,
      },
    });
    emitToDashboard('takeover_changed', {
      conversationId: conv.id,
      humanTakeover: true,
      attentionRequested: true,
    });
    return true;
  }

  if (decision === 'team') {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        humanTakeover: true,
        humanTakeoverUntil: new Date(Date.now() + HUMAN_TAKEOVER_MS),
        contextJson: {
          ...ctx,
          teamHelpRequestedAt: new Date().toISOString(),
        } as never,
      },
    });
    emitToDashboard('takeover_changed', {
      conversationId: conv.id,
      humanTakeover: true,
      teamHelpRequested: true,
    });
    await sendText(
      input.customerWhatsappNumber,
      'Okay, the boutique team will reply here.',
      { ignoreTakeover: true },
    );
    return true;
  }

  if (decision === 'resume_yes') {
    await resumeFreshOrderFromPausedContext(input, conv, ctx);
    return true;
  }

  const pendingRestart = await buildPendingRestartContext(input, event, ctx);
  if (!hasReusablePendingRestart(ctx, pendingRestart)) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        state: ConversationState.AWAITING_NEW_PRODUCT,
        humanTakeover: false,
        humanTakeoverUntil: null,
        intent: Intent.ORDER_INTENT,
        contextJson: rejectedProductContext(ctx) as never,
      },
    });
    emitToDashboard('takeover_changed', {
      conversationId: conv.id,
      humanTakeover: false,
      awaitingNewProduct: true,
    });
    await sendText(input.customerWhatsappNumber, NEW_PRODUCT_AFTER_CANCEL_MESSAGE, {
      ignoreTakeover: true,
    });
    return true;
  }

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      state: ConversationState.IDLE,
      humanTakeover: true,
      humanTakeoverUntil: new Date(Date.now() + HUMAN_TAKEOVER_MS),
      contextJson: {
        ...ctx,
        pendingRestart,
      } as never,
    },
  });
  emitToDashboard('takeover_changed', {
    conversationId: conv.id,
    humanTakeover: true,
    resumeRequested: true,
  });
  await sendText(input.customerWhatsappNumber, RESUME_CONFIRMATION_MESSAGE, {
    ignoreTakeover: true,
  });
  return true;
}

async function handleStatePriorityInput(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  const ctx = readOrderContext(conv.contextJson);

  if (conv.state === ConversationState.AWAITING_NEW_PRODUCT) {
    if (event.type === 'TEXT' && !shouldStateMachineHandleControlText(conv.state, event, ctx)) {
      const matched = await findProductByText(event.body);
      if (matched) {
        await beginOrderFromProduct(input, matched.id, extractRequestedSize(event.body), ctx);
        return true;
      }
    }
    await runTransitionAndPersist(input, conv, event);
    return true;
  }

  if (shouldStateMachineHandleControlText(conv.state, event, ctx)) {
    await runTransitionAndPersist(input, conv, event);
    return true;
  }

  return false;
}

function shouldStateMachineHandleControlText(
  state: ConversationState,
  event: ChatEvent,
  ctx: OrderContext,
): boolean {
  if (event.type !== 'TEXT') return false;
  if (ctx.cancelClarificationPending) return true;
  if (isProductChangeFlowState(state) && isProductChangeIntent(event.body)) return true;
  if (isAmbiguousCancelFlowState(state) && isAmbiguousCancelIntent(event.body)) return true;
  if (isDirectCancelIntent(event.body) && state !== ConversationState.IDLE) return true;
  return false;
}

function isProductChangeFlowState(state: ConversationState): boolean {
  return ([
    ConversationState.AWAITING_PRODUCT_CONFIRMATION,
    ConversationState.AWAITING_SIZE,
    ConversationState.AWAITING_QTY,
    ConversationState.AWAITING_NAME,
    ConversationState.AWAITING_ADDRESS,
    ConversationState.AWAITING_PINCODE,
    ConversationState.AWAITING_PAYMENT,
  ] as ConversationState[]).includes(state);
}

function isAmbiguousCancelFlowState(state: ConversationState): boolean {
  return ([
    ConversationState.AWAITING_PRODUCT_CONFIRMATION,
    ConversationState.AWAITING_NEW_PRODUCT,
    ConversationState.AWAITING_SIZE,
    ConversationState.AWAITING_QTY,
    ConversationState.AWAITING_NAME,
    ConversationState.AWAITING_ADDRESS,
    ConversationState.AWAITING_PINCODE,
    ConversationState.AWAITING_PAYMENT,
  ] as ConversationState[]).includes(state);
}

function rejectedProductContext(ctx: OrderContext): OrderContext {
  return compactOrderContext({
    productRejected: true,
    lastMatchedProductRejected: true,
    lastImageUsable: false,
    awaitingNewProduct: true,
    rejectedProductId: ctx.productId ?? ctx.rejectedProductId,
    lastRejectedProductId: ctx.productId ?? ctx.lastRejectedProductId ?? ctx.rejectedProductId,
    rejectedImageMediaId: ctx.lastMatchedImageMediaId ?? ctx.rejectedImageMediaId,
  });
}

function compactOrderContext(ctx: OrderContext): OrderContext {
  return Object.fromEntries(
    Object.entries(ctx).filter(([, value]) => value !== undefined),
  ) as OrderContext;
}

async function runTransitionAndPersist(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<void> {
  let result = transition(conv.state, event, readOrderContext(conv.contextJson));
  result = await executeActions(input, conv, result);
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { state: result.nextState, contextJson: result.context as never },
  });
}

async function handleCatalogOptionsIntent(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (event.type !== 'TEXT') return false;
  const ctx = readOrderContext(conv.contextJson);
  const detailed = await classifyCustomerIntent(buildCustomerIntentInput(event.body, conv.state, ctx));

  if (detailed.intent === 'REJECT_PRODUCT' && conv.state === ConversationState.AWAITING_PRODUCT_CONFIRMATION) {
    await askForNewProductAfterRejection(input, ctx);
    return true;
  }

  if (detailed.intent === 'SELECT_PRODUCT_FROM_LIST' && ctx.availableProductOptions?.length) {
    const productId = await selectProductIdFromShownOptions(ctx, detailed.selectedIndex, detailed.productQuery ?? event.body);
    if (!productId) {
      await sendText(input.customerWhatsappNumber, 'Please reply with one of the product numbers shown in the list.');
      return true;
    }
    await askSelectedProductConfirmation(input, productId, ctx);
    return true;
  }

  if (ctx.availableProductOptions?.length && detailed.intent === 'UNKNOWN') {
    const productId = await selectProductIdFromShownOptions(ctx, null, event.body);
    if (productId) {
      await askSelectedProductConfirmation(input, productId, ctx);
      return true;
    }
  }

  if (
    detailed.intent === 'SHOW_AVAILABLE_PRODUCTS' ||
    detailed.intent === 'ASK_MORE_OPTIONS'
  ) {
    await sendAvailableProductsList(input, ctx, null);
    return true;
  }

  if (detailed.intent === 'SHOW_PRODUCTS_BY_SIZE' && detailed.size) {
    await sendAvailableProductsList(input, ctx, detailed.size);
    return true;
  }

  if (
    (ctx.productRejected || ctx.lastMatchedProductRejected || conv.state === ConversationState.AWAITING_NEW_PRODUCT) &&
    (detailed.intent === 'ASK_STOCK' || detailed.intent === 'ASK_SIZE_AVAILABILITY')
  ) {
    if (detailed.size) {
      await sendAvailableProductsList(input, ctx, detailed.size);
      return true;
    }
    await sendAvailableProductsList(input, ctx, null);
    return true;
  }

  return false;
}

function buildCustomerIntentInput(
  text: string,
  state: ConversationState,
  ctx: OrderContext,
): CustomerIntentInput {
  return {
    text,
    currentState: state,
    lastSelectedProduct: ctx.productName ?? ctx.productId ?? null,
    lastRejectedProduct: ctx.lastRejectedProductId ?? ctx.rejectedProductId ?? null,
    knownSize: ctx.size ?? ctx.requestedSize ?? null,
    lastBotWasProductConfirmation: state === ConversationState.AWAITING_PRODUCT_CONFIRMATION,
    availableProductListShown: Boolean(ctx.availableProductListShown && ctx.availableProductOptions?.length),
  };
}

async function selectProductIdFromShownOptions(
  ctx: OrderContext,
  selectedIndex: number | null,
  productQuery: string | null,
): Promise<string | null> {
  if (selectedIndex !== null) return ctx.availableProductOptions?.[selectedIndex - 1] ?? null;
  if (!productQuery) return null;
  const normalized = normalizeQuery(productQuery);
  const indexMatch = normalized.match(/^\d+$/);
  if (indexMatch) return ctx.availableProductOptions?.[Number.parseInt(indexMatch[0], 10) - 1] ?? null;
  const matched = await findProductByText(productQuery);
  if (matched && ctx.availableProductOptions?.includes(matched.id)) return matched.id;
  return null;
}

async function buildPendingRestartContext(
  input: OrchestratorInput,
  event: ChatEvent,
  ctx: OrderContext,
): Promise<NonNullable<OrderContext['pendingRestart']>> {
  const text =
    event.type === 'TEXT'
      ? event.body
      : event.type === 'IMAGE'
        ? event.caption
        : event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY'
          ? event.title
          : undefined;
  const quotedImageMediaId = input.message.type === 'text'
    ? await findReferencedImageMediaId(input.message.context?.id)
    : null;
  const latestImageMediaId = event.type === 'IMAGE'
    ? event.mediaId
    : quotedImageMediaId ?? (
        canUseConversationImageForRestart(ctx)
          ? await findLatestConversationImageMediaId(input.conversationId)
          : null
      );

  return {
    ...(event.type === 'IMAGE' ? { imageMediaId: event.mediaId } : {}),
    ...(quotedImageMediaId ? { quotedImageMediaId } : {}),
    ...(latestImageMediaId ? { latestImageMediaId } : {}),
    ...(event.type === 'IMAGE' && event.caption ? { caption: event.caption } : {}),
    ...(text ? { text } : {}),
    ...(ctx.orderId ? { previousCancelledOrderId: ctx.orderId } : {}),
    requestedAt: new Date().toISOString(),
  };
}

async function resumeFreshOrderFromPausedContext(
  input: OrchestratorInput,
  conv: Conversation,
  ctx: OrderContext,
): Promise<void> {
  const pending = ctx.pendingRestart;
  if (!hasReusablePendingRestart(ctx, pending)) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        state: ConversationState.AWAITING_NEW_PRODUCT,
        contextJson: rejectedProductContext(ctx) as never,
        humanTakeover: false,
        humanTakeoverUntil: null,
        intent: Intent.ORDER_INTENT,
      },
    });
    await sendText(input.customerWhatsappNumber, PRODUCT_FIRST_MESSAGE, { ignoreTakeover: true });
    return;
  }

  const mediaId = pending?.quotedImageMediaId ?? pending?.imageMediaId ?? pending?.latestImageMediaId ?? null;
  const text = pending?.caption ?? pending?.text ?? '';

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      state: ConversationState.IDLE,
      contextJson: {},
      humanTakeover: false,
      humanTakeoverUntil: null,
      intent: Intent.ORDER_INTENT,
    },
  });

  if (mediaId) {
    await sendText(input.customerWhatsappNumber, 'Starting a fresh order from this product photo...');
    const outcome = await runProductMatchOutcome(mediaId);
    await respondToProductMatchOutcome(input, outcome, extractRequestedSize(text), mediaId);
    return;
  }

  if (text) {
    const matched = await findProductByText(text);
    if (matched) {
      await beginOrderFromProduct(input, matched.id, extractRequestedSize(text));
      return;
    }
  }

  await sendText(
    input.customerWhatsappNumber,
    'Sure. Please send the product photo or article number so I can check availability.',
  );
}

async function reconcileOrderContextBeforeTurn(
  input: OrchestratorInput,
  conv: Conversation,
): Promise<{ conversation: Conversation; stop: boolean }> {
  const ctx = readOrderContext(conv.contextJson);
  if (stateRequiresPersistedOrder(conv.state) && !ctx.orderId) {
    await pauseConversationForBot(conv.id, 'stale_order');
    logger.warn({ conversationId: conv.id, state: conv.state }, 'payment state had no order context; bot paused');
    return {
      conversation: {
        ...conv,
        state: ConversationState.IDLE,
        contextJson: pausedContext('stale_order') as never,
      },
      stop: true,
    };
  }

  if (!ctx.orderId) return { conversation: conv, stop: false };

  const order = await prisma.order.findUnique({
    where: { id: ctx.orderId },
    select: { id: true, customerId: true, status: true, orderNumber: true, totalAmount: true },
  });
  if (!order || order.customerId !== input.customerId) {
    await pauseConversationForBot(conv.id, 'stale_order');
    logger.warn({ conversationId: conv.id, orderId: ctx.orderId }, 'order context points to missing/wrong order; bot paused');
    return {
      conversation: {
        ...conv,
        state: ConversationState.IDLE,
        contextJson: pausedContext('stale_order') as never,
      },
      stop: true,
    };
  }

  if (order.status === OrderStatus.EXPIRED) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { state: ConversationState.IDLE, contextJson: {} },
    });
    await sendText(
      input.customerWhatsappNumber,
      `Order #${order.orderNumber} expired because payment was not received in time. Please send the product photo/name again to start a fresh order.`,
    );
    return { conversation: { ...conv, state: ConversationState.IDLE, contextJson: {} }, stop: true };
  }

  if (order.status === OrderStatus.CANCELLED) {
    await pauseConversationForBot(conv.id, 'order_closed');
    logger.info({ conversationId: conv.id, orderId: order.id }, 'cancelled order context cleared and bot paused');
    return {
      conversation: {
        ...conv,
        state: ConversationState.IDLE,
        contextJson: pausedContext('order_closed') as never,
      },
      stop: true,
    };
  }

  if (!isOrderStatusActiveForConversation(order.status)) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { state: ConversationState.IDLE, contextJson: {} },
    });
    return { conversation: { ...conv, state: ConversationState.IDLE, contextJson: {} }, stop: false };
  }

  if (ctx.orderNumber && ctx.total !== undefined) return { conversation: conv, stop: false };

  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      contextJson: {
        ...ctx,
        orderNumber: ctx.orderNumber ?? order.orderNumber,
        total: ctx.total ?? Number(order.totalAmount.toString()),
      } as never,
    },
  });
  return {
    conversation: {
      ...conv,
      contextJson: {
        ...ctx,
        orderNumber: ctx.orderNumber ?? order.orderNumber,
        total: ctx.total ?? Number(order.totalAmount.toString()),
      } as never,
    },
    stop: false,
  };
}

// ============================================================================
// Convert webhook message → state machine event
// ============================================================================

async function messageToEvent(msg: IncomingMessage): Promise<ChatEvent> {
  switch (msg.type) {
    case 'text':
      {
        const referencedMediaId = await findReferencedImageMediaId(msg.context?.id);
        if (referencedMediaId && detectCustomerIntent(msg.text.body).shouldTriggerBot) {
          return { type: 'IMAGE', mediaId: referencedMediaId, caption: msg.text.body };
        }
      }
      return { type: 'TEXT', body: msg.text.body };
    case 'image':
      return { type: 'IMAGE', mediaId: msg.image.id, caption: msg.image.caption };
    case 'interactive':
      if (msg.interactive.type === 'button_reply') {
        return {
          type: 'BUTTON_REPLY',
          id: msg.interactive.button_reply.id,
          title: msg.interactive.button_reply.title,
        };
      }
      return {
        type: 'LIST_REPLY',
        id: msg.interactive.list_reply.id,
        title: msg.interactive.list_reply.title,
      };
    case 'button':
      return { type: 'BUTTON_REPLY', id: msg.button.payload, title: msg.button.text };
    default:
      return { type: 'TEXT', body: '' };
  }
}

function detectDeterministicIntent(
  msg: IncomingMessage,
  logContext: { conversationId: string; senderLast4: string | null },
): Intent | null {
  if (msg.type === 'image' || msg.type === 'interactive' || msg.type === 'button') {
    return Intent.ORDER_INTENT;
  }
  if (msg.type !== 'text') return Intent.UNKNOWN;

  const text = msg.text.body;
  const customerIntent = detectCustomerIntent(text);
  botLog('TEXT_INTENT_CLASSIFIED', {
    conversationId: logContext.conversationId,
    senderLast4: logContext.senderLast4,
    intent: customerIntent.intent,
    shouldTriggerBot: customerIntent.shouldTriggerBot,
  });
  if (customerIntent.shouldTriggerBot) {
    return Intent.ORDER_INTENT;
  }
  return customerIntent.intent === 'casual' ? Intent.PERSONAL_CHAT : Intent.UNKNOWN;
}

function isActiveOrderState(state: ConversationState): boolean {
  return state !== ConversationState.IDLE &&
    state !== ConversationState.COMPLETED &&
    state !== ConversationState.ABANDONED;
}

type TakeoverDecision = 'skip' | 'continue' | 'handled';

async function resolveTakeoverForTrigger(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<TakeoverDecision> {
  if (event.type === 'TEXT') {
    if (!looksLikeBotTriggerText(event.body)) return 'skip';
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { humanTakeover: false, humanTakeoverUntil: null },
    });
    botLog('INTENT_DETECTED', {
      conversationId: conv.id,
      intent: Intent.ORDER_INTENT,
      source: 'takeover_release_trigger',
    });
    return 'continue';
  }

  if (event.type === 'IMAGE') {
    // Release takeover first so any availability reply is not suppressed by the
    // takeover send-guard. The photo is still processed silently — we only
    // reply on a high-confidence inventory match.
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        humanTakeover: false,
        humanTakeoverUntil: null,
        intent: Intent.ORDER_INTENT,
      },
    });
    botLog('INTENT_DETECTED', {
      conversationId: conv.id,
      intent: Intent.ORDER_INTENT,
      source: 'takeover_release_photo_match',
    });
    await processInboundProductImage(input, event.mediaId, extractRequestedSize(event.caption ?? ''));
    return 'handled';
  }

  return 'skip';
}

function looksLikeBotTriggerText(text: string): boolean {
  return detectCustomerIntent(text).shouldTriggerBot;
}

async function buildIntentInput(
  msg: IncomingMessage,
): Promise<{ text?: string; imageBase64?: string; imageMediaType?: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' }> {
  if (msg.type === 'text') return { text: msg.text.body };
  if (msg.type === 'image') {
    try {
      const downloaded = await downloadMedia(msg.image.id);
      const buf = await fs.readFile(storage.resolve(downloaded.storedPath));
      return {
        imageBase64: buf.toString('base64'),
        imageMediaType: normalizeMime(downloaded.mimeType),
        text: msg.image.caption,
      };
    } catch (err) {
      logger.warn({ err }, 'failed to download image for intent classification');
      return { text: msg.image.caption };
    }
  }
  if (msg.type === 'interactive') {
    if (msg.interactive.type === 'button_reply') return { text: msg.interactive.button_reply.title };
    return { text: msg.interactive.list_reply.title };
  }
  return {};
}

function normalizeMime(m: string): 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  if (m.includes('png')) return 'image/png';
  if (m.includes('webp')) return 'image/webp';
  if (m.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}

function last4(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(-4);
}

// ============================================================================
// Execute the actions returned by the state machine
// ============================================================================

async function executeActions(
  input: OrchestratorInput,
  conv: Conversation,
  initial: ReturnType<typeof transition>,
): Promise<ReturnType<typeof transition>> {
  let result = initial;
  // We may re-enter the state machine for follow-up events (e.g. PRODUCT_MATCH_RESULT).
  const queue: Action[] = [...result.actions];
  const to = input.customerWhatsappNumber;

  while (queue.length) {
    const action = queue.shift()!;
    try {
      switch (action.type) {
        case 'SEND_TEXT':
          botLog('AI_REPLY_GENERATED', {
            source: 'template',
            channel: 'text',
            preview: action.body.slice(0, 200),
          });
          await sendText(to, action.body);
          break;

        case 'SEND_BUTTONS':
          botLog('AI_REPLY_GENERATED', {
            source: 'template',
            channel: 'interactive_buttons',
            preview: action.body.slice(0, 200),
          });
          await sendInteractiveButtons(to, action.body, action.buttons);
          break;

        case 'SEND_LIST':
          botLog('AI_REPLY_GENERATED', {
            source: 'template',
            channel: 'interactive_list',
            preview: action.body.slice(0, 200),
          });
          await sendInteractiveList(to, action.body, action.buttonText, action.sections);
          break;

        case 'RESET_CONTEXT':
          {
            const cancelled = await cancelContextOrderIfAllowed(conv);
            if (cancelled.orderId && cancelled.cancelled) {
              emitToDashboard('order_status_changed', {
                orderId: cancelled.orderId,
                status: 'CANCELLED',
              });
            }
          }
          result = {
            ...result,
            nextState: ConversationState.IDLE,
            context: pausedContext('customer_cancelled', readOrderContext(conv.contextJson)),
          };
          break;

        case 'CANCEL_CONTEXT_ORDER':
          {
            const cancelled = await cancelContextOrderIfAllowed(conv);
            if (cancelled.orderId && cancelled.cancelled) {
              emitToDashboard('order_status_changed', {
                orderId: cancelled.orderId,
                status: 'CANCELLED',
              });
            }
          }
          break;

        case 'MARK_HUMAN_TAKEOVER':
          await prisma.conversation.update({
            where: { id: conv.id },
            data: {
              humanTakeover: true,
              humanTakeoverUntil: new Date(Date.now() + HUMAN_TAKEOVER_MS),
            },
          });
          break;

        case 'RUN_PRODUCT_MATCH': {
          await processInboundProductImage(input, action.mediaId, null);
          const updated = await prisma.conversation.findUnique({
            where: { id: conv.id },
            select: { state: true, contextJson: true },
          });
          if (updated) {
            result = {
              ...result,
              nextState: updated.state,
              context: (updated.contextJson as OrderContext) ?? {},
            };
          }
          queue.length = 0;
          break;
        }

        case 'SUGGEST_ALTERNATIVES': {
          const alts = await suggestAlternatives(action.productId);
          if (alts.length === 0) {
            await sendText(to, "Sorry, we couldn't find alternatives right now. Try again later.");
          } else {
            await sendInteractiveList(to, 'These are similar items in stock:', 'Pick one', [
              {
                title: 'Alternatives',
                rows: alts.map((a) => ({
                  id: `alt_${a.id}`,
                  title: a.name.slice(0, 24),
                  description: `₹${a.basePrice}`,
                })),
              },
            ]);
          }
          break;
        }

        case 'CREATE_ORDER': {
          const stockCheck = result.context.productId && result.context.size && result.context.qty
            ? await checkStock(result.context.productId, result.context.size, result.context.qty)
            : null;
          botLog('STOCK_CHECKED', {
            productId: result.context.productId ?? null,
            size: result.context.size ?? null,
            qty: result.context.qty ?? null,
            available: stockCheck?.available ?? false,
            stock: stockCheck?.stock ?? 0,
            reserved: stockCheck?.reserved ?? 0,
            physicalStock: stockCheck?.physicalStock ?? 0,
          });
          if (!stockCheck?.available) {
            await sendText(
              to,
              `Sorry, the size ${result.context.size ?? ''} is currently out of stock. Let me show alternatives.`,
            );
            if (result.context.productId) {
              queue.push({ type: 'SUGGEST_ALTERNATIVES', productId: result.context.productId });
            }
            result = { ...result, nextState: ConversationState.IDLE, context: {} };
            break;
          }
          const created = await createOrderFromContext({
            customerId: input.customerId,
            ctx: result.context,
          });
          if (!created) {
            await sendText(to, "Something went wrong creating your order. Please try again or type 'agent'.");
            break;
          }
          result = {
            ...result,
            context: {
              ...result.context,
              orderId: created.orderId,
              orderNumber: created.orderNumber,
              total: created.total,
            },
          };
          const settings = await getBusinessSettings();
          await sendText(
            to,
            `Order #${created.orderNumber} created!\n\nPlease send your payment of ₹${created.total} to UPI: ${settings.upiId}\n\nReply with a screenshot once done.`,
          );
          emitToDashboard('order_created', { orderId: created.orderId });
          break;
        }

        case 'RUN_PAYMENT_EXTRACTION': {
          // Prefer the order in conversation context, then fall back to latest pending order.
          const order = result.context.orderId
            ? await prisma.order.findFirst({
                where: {
                  id: result.context.orderId,
                  customerId: input.customerId,
                  status: {
                    in: [
                      OrderStatus.PENDING,
                      OrderStatus.PAYMENT_RECEIVED,
                      OrderStatus.PAYMENT_REVIEW,
                      OrderStatus.REJECTED,
                    ],
                  },
                },
              })
            : await prisma.order.findFirst({
                where: {
                  customerId: input.customerId,
                  status: { in: [OrderStatus.PENDING] },
                },
                orderBy: { createdAt: 'desc' },
              });
          if (!order) {
            logger.warn({ customerId: input.customerId }, 'no pending order found for payment screenshot');
            queue.length = 0;
            result = { ...result, nextState: ConversationState.AWAITING_PAYMENT };
            await sendText(to, 'I could not find an active unpaid order. Please type "menu" to start again or "agent" for help.');
            break;
          }
          let downloaded: Awaited<ReturnType<typeof downloadMedia>>;
          try {
            downloaded = await downloadMedia(action.mediaId);
          } catch (err) {
            logger.error({ err, orderId: order.id }, 'payment screenshot download failed');
            queue.length = 0;
            result = { ...result, nextState: ConversationState.AWAITING_PAYMENT };
            await sendText(to, 'I could not download that screenshot. Please resend a clear payment screenshot.');
            break;
          }

          try {
            const settings = await getBusinessSettings();
            const buf = await fs.readFile(storage.resolve(downloaded.storedPath));
            const extraction = await extractPayment({
              imageBase64: buf.toString('base64'),
              imageMediaType: normalizeMime(downloaded.mimeType),
              expectedAmount: Number(order.totalAmount.toString()),
              expectedReceiverUpi: settings.upiId,
            });
            const extractedAmount = extraction.amount ?? null;
            const extractedUtr = extraction.utr?.trim() || null;
            const extractedReceiver = extraction.receiverUpi?.trim() ?? extraction.receiverName?.trim() ?? null;
            const warnings = await getPaymentReviewWarnings({
              orderId: order.id,
              expectedAmount: Number(order.totalAmount.toString()),
              expectedReceiverUpi: settings.upiId,
              extractedAmount,
              extractedReceiver,
              extractedUtr,
              looksLegitimate: extraction.looksLegitimate,
            });
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: warnings.length > 0 ? OrderStatus.PAYMENT_REVIEW : OrderStatus.PAYMENT_RECEIVED,
                paymentScreenshotUrl: downloaded.storedPath,
                paymentExtractedAmount: extractedAmount !== null
                  ? new Prisma.Decimal(extractedAmount)
                  : null,
                paymentExtractedUtr: extractedUtr,
                paymentExtractedReceiver: extractedReceiver,
                paymentLooksLegitimate: extraction.looksLegitimate,
              },
            });
            emitToDashboard('payment_received', { orderId: order.id });
            await notifyAdminsOfPendingPayment(input, order, result.context, extractedUtr);
          } catch (err) {
            logger.error({ err, orderId: order.id }, 'payment extraction failed');
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.PAYMENT_REVIEW,
                paymentScreenshotUrl: downloaded.storedPath,
                paymentExtractedAmount: null,
                paymentExtractedUtr: null,
                paymentExtractedReceiver: null,
                paymentLooksLegitimate: false,
              },
            });
            emitToDashboard('payment_received', { orderId: order.id, extractionFailed: true });
            await notifyAdminsOfPendingPayment(input, order, result.context, null);
          }
          break;
        }

        case 'NOTIFY_DASHBOARD':
          emitToDashboard(action.event, { conversationId: conv.id });
          break;
      }
    } catch (err) {
      botError('ERROR_DETAILS', err, { step: 'orchestrator_action', action: action.type });
    }
  }

  return result;
}

/**
 * Alert the boutique owner/admins that a payment is awaiting approval. Sends at
 * most once per order (guarded by Order.adminNotifiedAt) and never throws — a
 * notification failure must not break the customer's payment flow, and the order
 * still shows as pending in the dashboard regardless.
 */
async function notifyAdminsOfPendingPayment(
  input: OrchestratorInput,
  order: {
    id: string;
    orderNumber: string;
    shippingName: string;
    totalAmount: { toString(): string };
    adminNotifiedAt: Date | null;
  },
  ctx: OrderContext,
  utr: string | null,
): Promise<void> {
  if (!shouldSendAdminNotification(order.adminNotifiedAt)) return;
  try {
    const outcome = await notifyAdminsPaymentPending({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: order.totalAmount.toString(),
      customerName: order.shippingName ?? ctx.customerName ?? null,
      customerPhone: input.customerWhatsappNumber,
      productName: ctx.productName ?? null,
      utr,
    });
    // Mark notified only when recipients were configured, so adding the owner
    // number later still triggers an alert on the next payment.
    if (outcome.attempted > 0) {
      await prisma.order.update({
        where: { id: order.id },
        data: { adminNotifiedAt: new Date() },
      });
    }
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'admin_payment_notification', orderId: order.id });
  }
}

async function handleIdleCatalogInquiry(input: OrchestratorInput, event: ChatEvent): Promise<boolean> {
  if (event.type === 'IMAGE') {
    await processInboundProductImage(input, event.mediaId, extractRequestedSize(event.caption ?? ''));
    return true;
  }

  if ((event.type === 'LIST_REPLY' || event.type === 'BUTTON_REPLY') && event.id === 'menu_browse') {
    await sendCatalogSamples(input.customerWhatsappNumber, 'sample suits');
    return true;
  }

  if ((event.type === 'LIST_REPLY' || event.type === 'BUTTON_REPLY') && event.id === 'menu_agent') {
    await sendText(
      input.customerWhatsappNumber,
      'Connecting you to a human. We will reply as soon as possible — thank you for your patience.',
    );
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        humanTakeover: true,
        humanTakeoverUntil: new Date(Date.now() + HUMAN_TAKEOVER_MS),
      },
    });
    return true;
  }

  if ((event.type === 'LIST_REPLY' || event.type === 'BUTTON_REPLY') && event.id === 'menu_status') {
    await sendOrderStatus(input, '');
    return true;
  }

  if (
    (event.type === 'LIST_REPLY' || event.type === 'BUTTON_REPLY') &&
    (event.id.startsWith('product_') || event.id.startsWith('alt_'))
  ) {
    const productId = event.id.replace(/^(product_|alt_)/, '');
    await beginOrderFromProduct(input, productId, null);
    return true;
  }

  if (event.type !== 'TEXT') return false;

  const text = event.body;
  if (looksLikeBrowseRequest(text)) {
    await sendCatalogSamples(input.customerWhatsappNumber, text);
    return true;
  }

  if (!looksLikeProductInquiry(text)) return false;

  if (looksLikePhotoFollowUp(text)) {
    const recentMediaId = await findRecentConversationImageMediaId(input.conversationId);
    if (recentMediaId) {
      logger.info({ conversationId: input.conversationId }, 'using recent image context');
      await sendText(input.customerWhatsappNumber, 'Got it — checking the last photo for availability...');
      const outcome = await runProductMatchOutcome(recentMediaId);
      await respondToProductMatchOutcome(input, outcome, extractRequestedSize(text), recentMediaId);
      return true;
    }
  }

  const matched = await findProductByText(text);
  if (!matched) {
    await sendText(
      input.customerWhatsappNumber,
      'Please send the product photo or article name/number so I can check availability.',
    );
    return true;
  }
  await beginOrderFromProduct(input, matched.id, extractRequestedSize(text));
  return true;
}

async function handleProductConfirmationInput(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (conv.state !== ConversationState.AWAITING_PRODUCT_CONFIRMATION) return false;

  const ctx = (conv.contextJson as OrderContext) ?? {};
  const text =
    event.type === 'TEXT'
      ? event.body.trim()
      : event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY'
        ? event.title
        : '';

  if ((event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') && event.id.startsWith('match_')) {
    await beginOrderFromProduct(input, event.id.slice('match_'.length), extractRequestedSize(text), ctx);
    return true;
  }

  if ((event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') && event.id === 'product_confirm_yes') {
    if (!ctx.productId) {
      await requestClearerProductReference(input);
      return true;
    }
    await beginOrderFromProduct(input, ctx.productId, ctx.requestedSize ?? extractRequestedSize(text), ctx);
    return true;
  }

  if ((event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') && event.id === 'product_confirm_no') {
    await askForNewProductAfterRejection(input, ctx);
    return true;
  }

  if (event.type === 'TEXT') {
    if (/^(yes|y|haan|han|ha|ok|okay|correct|same|this|yeh|ye)$/i.test(text)) {
      if (!ctx.productId) {
        await requestClearerProductReference(input);
        return true;
      }
      await beginOrderFromProduct(input, ctx.productId, ctx.requestedSize ?? extractRequestedSize(text), ctx);
      return true;
    }
    if (/^(no|n|nahi|nahin|wrong|not this|dusra|alag)$/i.test(text)) {
      await askForNewProductAfterRejection(input, ctx);
      return true;
    }

    const textMatch = await findProductByText(text);
    if (textMatch) {
      await beginOrderFromProduct(input, textMatch.id, extractRequestedSize(text));
      return true;
    }
  }

  if (ctx.candidateProductIds?.length) {
    await sendText(input.customerWhatsappNumber, 'Please choose one of the listed products, or send a clearer photo/product name.');
    return true;
  }

  await sendInteractiveButtons(input.customerWhatsappNumber, 'Is this the product you want?', [
    { id: 'product_confirm_yes', title: 'Yes' },
    { id: 'product_confirm_no', title: 'No' },
  ]);
  return true;
}

async function handleQuestion(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (event.type !== 'TEXT') return false;
  const text = event.body.trim();
  if (!text) return false;

  const topic = detectQuestionTopic(text);
  if (!topic) return false;

  // In idle, availability/price questions often refer to a recent or quoted
  // product photo. Let the catalog inquiry path resolve the actual product.
  if (conv.state === ConversationState.IDLE && (topic === 'availability' || topic === 'price')) {
    return false;
  }

  if (topic === 'status') {
    await sendOrderStatus(input, text);
    return true;
  }

  const ctx = (conv.contextJson as OrderContext) ?? {};

  // Safety (priority handling): never quote stock/price for a product the
  // customer just rejected. Redirect to the available-products list instead so
  // the rejected article can never be shown as "available".
  if ((topic === 'availability' || topic === 'price') && isRejectedProductFlow(conv.state, ctx)) {
    await sendAvailableProductsList(input, ctx, null);
    return true;
  }

  const settings = await getBusinessSettings();
  const answer = await buildFaqAnswer(topic, text, ctx, settings);
  if (!answer) return false;

  await sendText(input.customerWhatsappNumber, answer);
  if (conv.state !== ConversationState.IDLE) {
    await repeatCurrentPrompt(input.customerWhatsappNumber, conv.state, ctx);
  }
  return true;
}

async function askForNewProductAfterRejection(
  input: OrchestratorInput,
  ctx: OrderContext,
): Promise<void> {
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_NEW_PRODUCT,
      contextJson: rejectedProductContext(ctx) as never,
    },
  });
  await sendText(input.customerWhatsappNumber, PRODUCT_REJECTED_MESSAGE);
}

/**
 * Spec safety rule (priority handling): the customer has just rejected a product
 * and has not selected a replacement yet. While this is true we must never quote
 * stock/price for the rejected product — re-selection or "show available
 * products" must come first.
 */
export function isRejectedProductFlow(state: ConversationState, ctx: OrderContext): boolean {
  return (
    state === ConversationState.AWAITING_NEW_PRODUCT ||
    Boolean(ctx.productRejected) ||
    Boolean(ctx.lastMatchedProductRejected)
  );
}

export interface AvailableProductOption {
  id: string;
  sku: string;
  name: string;
  basePrice: string;
  sizes: string[];
}

interface AvailableProductRow {
  id: string;
  sku: string;
  name: string;
  basePrice: { toString(): string };
  variants: { size: string; stock: number }[];
}

async function sendAvailableProductsList(
  input: OrchestratorInput,
  ctx: OrderContext,
  size: string | null,
): Promise<void> {
  const excludedProductId = ctx.lastRejectedProductId ?? ctx.rejectedProductId ?? null;
  const products = await findAvailableProductOptions({ size, excludedProductId, limit: 3 });

  if (products.length === 0) {
    if (size) {
      await prisma.conversation.update({
        where: { id: input.conversationId },
        data: {
          state: ConversationState.AWAITING_NEW_PRODUCT,
          contextJson: {
            ...rejectedProductContext(ctx),
            availableProductOptions: [],
            availableProductListShown: false,
            availableProductListSize: size,
          } as never,
        },
      });
      await sendText(
        input.customerWhatsappNumber,
        `Sorry, I couldn't find available products in size ${size}. Would you like to see all available products or talk to the boutique team?`,
      );
      return;
    }
    await sendText(input.customerWhatsappNumber, 'Sorry, I could not find available products right now. Please send another product photo/article number or talk to the boutique team.');
    return;
  }

  const header = size ? `Available products in size ${size}:` : 'Available products:';
  const body = `${header}\n${formatAvailableProductList(products)}\n\nReply with the product number to continue.`;
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_NEW_PRODUCT,
      intent: Intent.ORDER_INTENT,
      contextJson: {
        ...rejectedProductContext(ctx),
        availableProductOptions: products.map((product) => product.id),
        availableProductListShown: true,
        ...(size ? { availableProductListSize: size } : {}),
      } as never,
    },
  });
  await sendText(input.customerWhatsappNumber, body);
}

export function formatAvailableProductList(products: AvailableProductOption[]): string {
  return products
    .map((product, index) => `${index + 1}. ${product.name} — ₹${product.basePrice} — sizes ${product.sizes.join(', ')}`)
    .join('\n');
}

export function buildAvailableProductOptions(
  products: AvailableProductRow[],
  {
    size,
    excludedProductId,
    limit,
  }: {
    size: string | null;
    excludedProductId: string | null;
    limit: number;
  },
): AvailableProductOption[] {
  return products
    .filter((product) => product.id !== excludedProductId)
    .map((product) => {
      const sizes = [
        ...new Set(
          product.variants
            .filter((variant) => variant.stock > 0 && (!size || variant.size === size))
            .map((variant) => variant.size),
        ),
      ];
      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        basePrice: product.basePrice.toString(),
        sizes,
      };
    })
    .filter((product) => product.sizes.length > 0)
    .slice(0, limit);
}

async function findAvailableProductOptions({
  size,
  excludedProductId,
  limit,
}: {
  size: string | null;
  excludedProductId: string | null;
  limit: number;
}): Promise<AvailableProductOption[]> {
  const products = await prisma.product.findMany({
    where: {
      isActive: true,
      ...(excludedProductId ? { id: { not: excludedProductId } } : {}),
      variants: {
        some: {
          isActive: true,
          stock: { gt: 0 },
          ...(size ? { size } : {}),
        },
      },
    },
    include: {
      variants: {
        where: {
          isActive: true,
          stock: { gt: 0 },
          ...(size ? { size } : {}),
        },
        orderBy: { size: 'asc' },
      },
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: limit,
  });

  return buildAvailableProductOptions(products, { size, excludedProductId, limit });
}

async function askSelectedProductConfirmation(
  input: OrchestratorInput,
  productId: string,
  previousContext: OrderContext,
): Promise<void> {
  const availability = await getProductAvailability(productId);
  if (!availability || !availability.isActive) {
    await sendAvailableProductsList(input, previousContext, previousContext.availableProductListSize ?? null);
    return;
  }

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_PRODUCT_CONFIRMATION,
      intent: Intent.ORDER_INTENT,
      contextJson: {
        productId: availability.id,
        productName: availability.name,
        productPrice: Number(availability.basePrice),
        availableSizes: availability.variants.filter((variant) => variant.stock > 0).map((variant) => variant.size),
        productRejected: false,
        lastMatchedProductRejected: false,
        lastImageUsable: false,
        awaitingNewProduct: false,
        lastRejectedProductId: previousContext.lastRejectedProductId ?? previousContext.rejectedProductId,
        rejectedProductId: previousContext.rejectedProductId,
        rejectedImageMediaId: previousContext.rejectedImageMediaId,
      } as never,
    },
  });
  await sendInteractiveButtons(
    input.customerWhatsappNumber,
    `You selected ${availability.name}. Price ₹${availability.basePrice}. Is this the product you want?`,
    [
      { id: 'product_confirm_yes', title: 'Yes' },
      { id: 'product_confirm_no', title: 'No' },
    ],
  );
}

async function respondToProductMatchOutcome(
  input: OrchestratorInput,
  outcome: ProductMatchOutcome | null,
  requestedSize: string | null,
  sourceMediaId: string | null = null,
): Promise<void> {
  const threshold = env.IMAGE_MATCH_MIN_CONFIDENCE;
  const requiredMargin = env.IMAGE_MATCH_SECOND_BEST_MIN_MARGIN;
  const score = outcome?.confidence ?? 0;
  const matchedProductId = outcome?.matchedProductId ?? null;
  const bestSecondMargin = outcome?.bestSecondMargin ?? null;
  const hasClearBestMatch = bestSecondMargin === null || bestSecondMargin >= requiredMargin;
  logger.info(
    {
      conversationId: input.conversationId,
      score,
      threshold,
      bestSecondMargin,
      requiredMargin,
      band: outcome?.confidenceBand ?? 'none',
      matchedProductId,
    },
    'inventory match score',
  );

  // Accept ONLY a confident single match. Higher score = better match; anything
  // below the configured threshold or too close to the second-best candidate is
  // treated as no match.
  if (matchedProductId && outcome?.meetsThreshold && score >= threshold && hasClearBestMatch) {
    logger.info(
      { conversationId: input.conversationId, productId: matchedProductId, score },
      'inventory match accepted',
    );
    await beginOrderFromProduct(
      input,
      matchedProductId,
      requestedSize,
      sourceMediaId ? { lastMatchedImageMediaId: sourceMediaId } : {},
    );
    return;
  }

  // Below threshold / no match: never guess and never create an order. Reply to
  // the customer so the bot does not appear dead, and surface the issue for the
  // dashboard.
  logger.info(
    { conversationId: input.conversationId, score, threshold, reason: outcome?.reasoning ?? 'matcher_failed' },
    'inventory match rejected',
  );
  logger.info(
    { conversationId: input.conversationId, senderLast4: last4(input.customerWhatsappNumber), score },
    'image ignored: no inventory match',
  );
  emitToDashboard('image_unmatched', {
    conversationId: input.conversationId,
    score,
    hasCandidate: Boolean(matchedProductId),
  });

  await requestClearerProductReference(input, outcome?.candidates ?? []);
}

async function requestClearerProductReference(
  input: OrchestratorInput,
  candidates: ProductMatchCandidate[] = [],
): Promise<void> {
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { state: ConversationState.IDLE, contextJson: {} },
  });
  await sendText(input.customerWhatsappNumber, UNMATCHED_IMAGE_REPLY);
  const top = candidates.slice(0, 3);
  if (top.length === 0) return;
  await sendInteractiveList(input.customerWhatsappNumber, 'These are the closest catalog photos I found. Pick one only if it is correct:', 'View matches', [
    {
      title: 'Closest matches',
      rows: top.map((candidate) => ({
        id: `product_${candidate.productId}`,
        title: candidate.name.slice(0, 24),
        description: `${candidate.sku} | ${Math.round(candidate.confidence * 100)}% match`,
      })),
    },
  ]);
}

async function beginOrderFromProduct(
  input: OrchestratorInput,
  productId: string,
  requestedSize: string | null,
  previousContext: OrderContext = {},
): Promise<void> {
  const availability = await getProductAvailability(productId);
  if (!availability || !availability.isActive) {
    await sendText(input.customerWhatsappNumber, 'This is not available.');
    return;
  }

  const availableVariants = availability.variants.filter((v) => v.stock > 0);
  const availableSizes = [...new Set(availableVariants.map((v) => v.size))];
  const baseContext: OrderContext = {
    productId: availability.id,
    productName: availability.name,
    productPrice: Number(availability.basePrice),
    availableSizes,
    ...(previousContext.lastMatchedImageMediaId
      ? { lastMatchedImageMediaId: previousContext.lastMatchedImageMediaId }
      : {}),
    lastImageUsable: true,
    awaitingNewProduct: false,
    productRejected: false,
  };

  botLog('STOCK_CHECKED', {
    productId,
    requestedSize,
    totalStock: availableVariants.reduce((sum, v) => sum + v.stock, 0),
    stockBySize: availability.variants.map((v) => ({
      size: v.size,
      stock: v.stock,
      reserved: v.reserved,
      physicalStock: v.physicalStock,
    })),
  });
  logger.info(
    {
      conversationId: input.conversationId,
      productId,
      inStock: availableSizes.length > 0,
      availableSizes,
    },
    'availability reply sent',
  );

  if (availableSizes.length === 0) {
    await sendText(
      input.customerWhatsappNumber,
      `Sorry, ${availability.name} is currently out of stock. Let me show similar available pieces.`,
    );
    const alts = await suggestAlternatives(productId);
    if (alts.length > 0) {
      await sendInteractiveList(input.customerWhatsappNumber, 'These are similar items in stock:', 'Pick one', [
        {
          title: 'Alternatives',
          rows: alts.map((a) => ({
            id: `alt_${a.id}`,
            title: a.name.slice(0, 24),
            description: `₹${a.basePrice}`,
          })),
        },
      ]);
    }
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { state: ConversationState.IDLE, contextJson: {} },
    });
    return;
  }

  if (requestedSize) {
    const variant = availableVariants.find((v) => sameSize(v.size, requestedSize));
    if (variant) {
      await prisma.conversation.update({
        where: { id: input.conversationId },
        data: {
          state: ConversationState.AWAITING_QTY,
          contextJson: { ...baseContext, size: variant.size } as never,
        },
      });
      await sendText(
        input.customerWhatsappNumber,
        `Yes — ${availability.name} is available in size ${variant.size}.\nPrice: ₹${availability.basePrice}\nAvailable stock: ${variant.stock} pc${variant.stock === 1 ? '' : 's'}.\nHow many pieces would you like?`,
      );
      return;
    }

    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        state: ConversationState.AWAITING_SIZE,
        contextJson: baseContext as never,
      },
    });
    await sendSizePicker(
      input.customerWhatsappNumber,
      `Sorry, size ${requestedSize} is not available for ${availability.name}. Available sizes: ${availableSizes.join(', ')}.`,
      availableSizes,
    );
    return;
  }

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_SIZE,
      contextJson: baseContext as never,
    },
  });
  const stockText = availableVariants.map((v) => `${v.size}: ${v.stock} pc${v.stock === 1 ? '' : 's'}`).join(', ');
  await sendSizePicker(
    input.customerWhatsappNumber,
    `Yes, available.\n${availability.name}\nPrice: ₹${availability.basePrice}\nStock by size: ${stockText}\nPlease choose your size.`,
    availableSizes,
  );
}

async function buildFaqAnswer(
  topic: FaqTopic,
  _text: string,
  ctx: OrderContext,
  settings: Awaited<ReturnType<typeof getBusinessSettings>>,
): Promise<string | null> {
  switch (topic) {
    case 'availability':
      if (!ctx.productId) return 'Please send the product photo or article name/number so I can check availability.';
      return buildAvailabilityAnswer(ctx);
    case 'price':
      if (!ctx.productId) return 'Please send the product photo or article name/number so I can check the price.';
      return buildPriceAnswer(ctx);
    case 'payment':
      return `Payment is accepted by UPI.\nUPI ID: ${settings.upiId}\nAfter payment, send the screenshot here for verification.`;
    case 'cod':
      return 'COD is not enabled in this automation right now. Please use UPI payment so we can verify and confirm the order.';
    case 'delivery':
      return `Default shipping is ₹${settings.shippingFee}. Orders are normally dispatched within 24 hours after payment verification.`;
    case 'policy':
      return 'Return/exchange requests are checked by the boutique team case by case. Type "agent" and share your order number for help.';
    case 'hours':
      return `Business hours: ${settings.workingHoursStart} to ${settings.workingHoursEnd}. You can still place an order here anytime.`;
    case 'location':
      return 'For boutique address or visit details, type "agent" and the team will share the latest location information.';
    case 'status':
      return null;
  }
}

async function buildAvailabilityAnswer(ctx: OrderContext): Promise<string> {
  if (!ctx.productId) return 'Please send the product photo or article name/number so I can check availability.';
  if (ctx.size && ctx.qty) {
    const stock = await checkStock(ctx.productId, ctx.size, ctx.qty);
    return stock.available
      ? `Yes, size ${ctx.size} is available for ${ctx.qty} pc${ctx.qty === 1 ? '' : 's'}.`
      : `Sorry, only ${stock.stock} pc${stock.stock === 1 ? '' : 's'} are available in size ${ctx.size}.`;
  }

  const availability = await getProductAvailability(ctx.productId);
  if (!availability) return 'This product is not available.';
  const available = availability.variants.filter((v) => v.stock > 0);
  if (available.length === 0) return 'This product is currently out of stock.';
  const stockText = available.map((v) => `${v.size}: ${v.stock} pc${v.stock === 1 ? '' : 's'}`).join(', ');
  return `Yes, available.\n${availability.name}\nStock by size: ${stockText}`;
}

async function buildPriceAnswer(ctx: OrderContext): Promise<string> {
  if (!ctx.productId) return 'Please send the product photo or article name/number so I can check the price.';
  const availability = await getProductAvailability(ctx.productId);
  if (!availability) return 'I could not find this product in the catalog.';
  return `${availability.name} is ₹${availability.basePrice}.`;
}

async function repeatCurrentPrompt(
  to: string,
  state: ConversationState,
  ctx: OrderContext,
): Promise<void> {
  switch (state) {
    case ConversationState.AWAITING_PRODUCT_CONFIRMATION:
      await sendText(to, 'Please wait while I check the product photo.');
      return;
    case ConversationState.AWAITING_NEW_PRODUCT:
      await sendText(to, PRODUCT_FIRST_MESSAGE);
      return;
    case ConversationState.AWAITING_SIZE:
      await sendSizePicker(to, 'Please choose your size to continue the order.', ctx.availableSizes ?? []);
      return;
    case ConversationState.AWAITING_QTY:
      await sendText(to, `Please tell me the quantity for size ${ctx.size ?? ''}.`);
      return;
    case ConversationState.AWAITING_NAME:
      await sendText(to, 'Please share the full name for the order.');
      return;
    case ConversationState.AWAITING_ADDRESS:
      await sendText(to, 'Please share the full delivery address.');
      return;
    case ConversationState.AWAITING_PINCODE:
      await sendText(to, 'Please share city, state, and 6-digit pincode.');
      return;
    case ConversationState.AWAITING_PAYMENT:
      await sendText(to, `Please send the UPI payment screenshot for ₹${ctx.total ?? 'the order total'}.`);
      return;
    case ConversationState.AWAITING_VERIFICATION:
      await sendText(to, 'Your payment screenshot is with us for verification.');
      return;
    case ConversationState.IDLE:
    case ConversationState.COMPLETED:
    case ConversationState.ABANDONED:
      return;
  }
}

async function sendSizePicker(to: string, body: string, sizes: string[]): Promise<void> {
  const uniqueSizes = [...new Set(sizes.filter(Boolean))].slice(0, 10);
  if (uniqueSizes.length === 0) {
    await sendText(to, body);
    return;
  }
  if (uniqueSizes.length <= 3) {
    await sendInteractiveButtons(
      to,
      body,
      uniqueSizes.map((size) => ({ id: `size_${size}`, title: size })),
    );
    return;
  }
  await sendInteractiveList(to, body, 'Pick size', [
    {
      title: 'Available sizes',
      rows: uniqueSizes.map((size) => ({ id: `size_${size}`, title: size })),
    },
  ]);
}

async function sendOrderStatus(input: OrchestratorInput, text: string): Promise<void> {
  const orderNumber = text.match(/\bORD-\d{4}-\d{4,}\b/i)?.[0]?.toUpperCase();
  const order = orderNumber
    ? await prisma.order.findFirst({
        where: { customerId: input.customerId, orderNumber },
        orderBy: { createdAt: 'desc' },
      })
    : await prisma.order.findFirst({
        where: { customerId: input.customerId },
        orderBy: { createdAt: 'desc' },
      });

  if (!order) {
    await sendText(input.customerWhatsappNumber, 'I could not find an order yet. Please share your order number or send a product photo to start.');
    return;
  }

  await sendText(
    input.customerWhatsappNumber,
    `Order #${order.orderNumber}: ${humanOrderStatus(order.status)}\nTotal: ₹${order.totalAmount.toString()}`,
  );
}

type FaqTopic =
  | 'availability'
  | 'price'
  | 'payment'
  | 'cod'
  | 'delivery'
  | 'policy'
  | 'hours'
  | 'location'
  | 'status';

function detectQuestionTopic(text: string): FaqTopic | null {
  const t = text.toLowerCase();
  if (/\b(status|track|tracking|shipped|order\s*#|ord-\d{4}-\d{4,})\b/.test(t)) return 'status';
  if (/\b(cod|cash on delivery|cash delivery)\b/.test(t)) return 'cod';
  if (/\b(upi|payment|pay|paid|screenshot|utr|transaction)\b/.test(t)) return 'payment';
  if (/\b(delivery|deliver|shipping|ship|dispatch|courier|charges|freight|kab milega)\b/.test(t)) return 'delivery';
  if (/\b(return|exchange|refund|replace|policy)\b/.test(t)) return 'policy';
  if (/\b(time|timing|hours|open|close|closed|khula|band)\b/.test(t)) return 'hours';
  if (/\b(location|shop address|boutique address|store address|visit|map)\b/.test(t)) return 'location';
  if (/\b(price|rate|cost|amount|kitna|kitne|mrp)\b/.test(t)) return 'price';
  if (/\b(available|availability|stock|mil jayega|hai kya|h kya)\b/.test(t)) return 'availability';
  return null;
}

function humanOrderStatus(status: OrderStatus): string {
  switch (status) {
    case OrderStatus.PENDING:
      return 'waiting for payment screenshot';
    case OrderStatus.PAYMENT_RECEIVED:
      return 'payment received, verification pending';
    case OrderStatus.PAYMENT_REVIEW:
      return 'payment received, manual review needed';
    case OrderStatus.VERIFIED:
      return 'confirmed, printing/packing next';
    case OrderStatus.PRINTED:
      return 'confirmed and printed for packing';
    case OrderStatus.DISPATCHED:
      return 'dispatched';
    case OrderStatus.CANCELLED:
      return 'cancelled';
    case OrderStatus.REJECTED:
      return 'payment rejected, please resend a clear screenshot';
    case OrderStatus.EXPIRED:
      return 'expired because payment was not received in time';
  }
}

function sameSize(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * True when inventory has at least one active, in-stock product with a
 * searchable image. If false, a customer photo can never match anything, so we
 * skip download/matching and send the standard no-confident-match fallback.
 */
async function hasSearchableInventoryImages(): Promise<boolean> {
  const count = await prisma.product.count({
    where: {
      isActive: true,
      imageUrl: { not: '' },
      variants: { some: { isActive: true, stock: { gt: 0 } } },
    },
  });
  return count > 0;
}

/**
 * Unified entry for an inbound customer product photo. Acknowledges the photo,
 * guards on real dashboard inventory, downloads + matches, and never proceeds
 * unless the match is high-confidence and unambiguous. Never throws — the
 * webhook has already returned 200.
 */
async function processInboundProductImage(
  input: OrchestratorInput,
  mediaId: string,
  requestedSize: string | null,
): Promise<void> {
  await sendText(input.customerWhatsappNumber, CHECKING_PRODUCT_MESSAGE);
  if (!(await hasSearchableInventoryImages())) {
    logger.info(
      { conversationId: input.conversationId, senderLast4: last4(input.customerWhatsappNumber) },
      'image ignored: inventory image index empty',
    );
    await requestClearerProductReference(input);
    return;
  }
  const outcome = await runProductMatchOutcome(mediaId);
  await respondToProductMatchOutcome(input, outcome, requestedSize, mediaId);
}

async function runProductMatchOutcome(mediaId: string): Promise<ProductMatchOutcome | null> {
  try {
    logger.info({ mediaId }, 'media download started');
    const downloaded = await downloadMedia(mediaId);
    logger.info({ mediaId, storedPath: downloaded.storedPath }, 'media download success');
    const buf = await fs.readFile(storage.resolve(downloaded.storedPath));
    logger.info({ mediaId }, 'inventory matching started');
    const outcome = await matchProduct({
      imageBase64: buf.toString('base64'),
      imageMediaType: normalizeMime(downloaded.mimeType),
    });
    logger.info(
      {
        mediaId,
        matchedProductId: outcome.matchedProductId ?? null,
        confidence: outcome.confidence,
        confidenceBand: outcome.confidenceBand,
      },
      outcome.matchedProductId ? 'product match found' : 'product match not found',
    );
    return outcome;
  } catch (err) {
    logger.error(
      { mediaId, err: err instanceof Error ? { name: err.name, message: err.message } : err },
      'media download or product match failed',
    );
    return null;
  }
}

export async function startFreshOrderFromConversationImage(conversationId: string): Promise<{ ok: boolean; reason?: string }> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { customer: { select: { id: true, whatsappNumber: true } } },
  });
  if (!conv) return { ok: false, reason: 'conversation_not_found' };

  const ctx = readOrderContext(conv.contextJson);
  const mediaId = await findLatestConversationImageMediaId(conversationId);
  if (!mediaId) return { ok: false, reason: 'no_image' };
  if (!canUseConversationImageForRestart(ctx) && mediaId === ctx.rejectedImageMediaId) {
    return { ok: false, reason: 'last_image_rejected' };
  }

  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      state: ConversationState.IDLE,
      contextJson: {},
      humanTakeover: false,
      humanTakeoverUntil: null,
      intent: Intent.ORDER_INTENT,
    },
  });

  const input: OrchestratorInput = {
    conversationId,
    customerId: conv.customer.id,
    customerWhatsappNumber: conv.customer.whatsappNumber,
    message: {
      from: conv.customer.whatsappNumber,
      id: `dashboard-start-${Date.now()}`,
      timestamp: Math.floor(Date.now() / 1000).toString(),
      type: 'image',
      image: { id: mediaId, mime_type: 'image/jpeg' },
    } as IncomingMessage,
  };
  await sendText(conv.customer.whatsappNumber, 'Starting a fresh order from the last product photo...');
  const outcome = await runProductMatchOutcome(mediaId);
  await respondToProductMatchOutcome(input, outcome, null, mediaId);
  return { ok: true };
}

async function findReferencedImageMediaId(whatsappMessageId: string | undefined): Promise<string | null> {
  if (!whatsappMessageId) return null;
  const referenced = await prisma.message.findUnique({
    where: { whatsappMessageId },
    select: { messageType: true, mediaUrl: true },
  });
  if (referenced?.messageType === MessageType.IMAGE && referenced.mediaUrl) {
    return referenced.mediaUrl;
  }
  return null;
}

// Recent-image context window. A customer may send a photo first and only ask
// "available?" some minutes later; 30 min matches the conversation-context TTL.
const RECENT_IMAGE_CONTEXT_MS = 30 * 60 * 1000;

async function findRecentConversationImageMediaId(conversationId: string): Promise<string | null> {
  const windowStart = new Date(Date.now() - RECENT_IMAGE_CONTEXT_MS);
  const image = await prisma.message.findFirst({
    where: {
      conversationId,
      messageType: MessageType.IMAGE,
      mediaUrl: { not: null },
      createdAt: { gte: windowStart },
    },
    orderBy: { createdAt: 'desc' },
    select: { mediaUrl: true },
  });
  return image?.mediaUrl ?? null;
}

async function findLatestConversationImageMediaId(conversationId: string): Promise<string | null> {
  const image = await prisma.message.findFirst({
    where: {
      conversationId,
      messageType: MessageType.IMAGE,
      mediaUrl: { not: null },
      direction: 'INBOUND',
    },
    orderBy: { createdAt: 'desc' },
    select: { mediaUrl: true },
  });
  return image?.mediaUrl ?? null;
}

async function findProductByText(text: string): Promise<{ id: string } | null> {
  const tokens = queryTokens(text);
  if (tokens.length === 0) return null;

  const products = await prisma.product.findMany({
    where: { isActive: true },
    include: { variants: true },
    take: 200,
  });

  let best: { id: string; score: number } | null = null;
  for (const p of products) {
    const haystack = normalizeQuery(`${p.sku} ${p.name} ${p.description} ${p.category}`);
    let score = 0;
    for (const token of tokens) {
      if (haystack.includes(token)) score += token.length <= 2 ? 1 : 2;
    }
    if (normalizeQuery(p.sku) === normalizeQuery(text)) score += 8;
    if (haystack.includes(normalizeQuery(text))) score += 6;
    if (p.variants.some((v) => v.stock > 0)) score += 1;
    if (!best || score > best.score) best = { id: p.id, score };
  }

  return best && best.score >= Math.max(3, Math.min(tokens.length * 2, 6)) ? { id: best.id } : null;
}

async function sendCatalogSamples(to: string, text: string): Promise<void> {
  const category = /\b(lehenga|lehengas)\b/i.test(text)
    ? 'Lehengas'
    : /\b(saree|sarees)\b/i.test(text)
      ? 'Sarees'
      : /\b(kurti|kurtis)\b/i.test(text)
        ? 'Kurtis'
        : 'Suits';

  const products = await prisma.product.findMany({
    where: { isActive: true, category: { contains: category, mode: 'insensitive' } },
    include: { variants: true },
    orderBy: { createdAt: 'desc' },
    take: 8,
  });

  const availability = await Promise.all(products.map((p) => getProductAvailability(p.id)));
  const inStock = products
    .map((p, index) => ({
      ...p,
      totalStock: availability[index]?.variants.reduce((sum, v) => sum + v.stock, 0) ?? 0,
    }))
    .filter((p) => p.totalStock > 0);

  if (inStock.length === 0) {
    botLog('AI_REPLY_GENERATED', {
      source: 'template',
      channel: 'text',
      preview: `No ${category.toLowerCase()} are in stock right now.`,
    });
    await sendText(to, `No ${category.toLowerCase()} are in stock right now.`);
    return;
  }

  botLog('AI_REPLY_GENERATED', {
    source: 'template',
    channel: 'interactive_list',
    preview: `Here are ${category.toLowerCase()} currently in stock:`,
  });
  await sendInteractiveList(to, `Here are ${category.toLowerCase()} currently in stock:`, 'View items', [
    {
      title: category,
      rows: inStock.map((p) => ({
        id: `product_${p.id}`,
        title: p.name.slice(0, 24),
        description: `₹${p.basePrice.toString()} | ${p.totalStock} pcs`,
      })),
    },
  ]);
}

function looksLikeProductInquiry(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(available|availability|stock|size|price|rate|cost|kitna|kitne|kya|hai|article|sku|code|suit|lehenga|saree|kurti|order|buy|piece|pcs)\b/.test(
    t,
  );
}

function looksLikeBrowseRequest(text: string): boolean {
  return /\b(show|browse|sample|samples|catalog|catalogue|collection|options|designs)\b/i.test(text);
}

function looksLikePhotoFollowUp(text: string): boolean {
  if (/\b(article|sku|code)\b/i.test(text)) return false;
  return /\b(this|it|yeh|photo|pic|picture|available|availability|stock|size)\b/i.test(text);
}

function extractRequestedSize(text: string): string | null {
  const normalized = text.toUpperCase();
  const sizeMatch = normalized.match(/\bSIZE\s*([A-Z0-9]{1,6})\b/);
  if (sizeMatch?.[1]) return sizeMatch[1];
  const numeric = normalized.match(/\b(3[0-9]|4[0-9]|5[0-9])\b/);
  if (numeric?.[1]) return numeric[1];
  const alpha = normalized.match(/\b(XXXL|XXL|XL|L|M|S|XS)\b/);
  return alpha?.[1] ?? null;
}

function queryTokens(text: string): string[] {
  const stop = new Set([
    'is',
    'it',
    'this',
    'that',
    'the',
    'in',
    'size',
    'available',
    'availability',
    'stock',
    'please',
    'pls',
    'hai',
    'kya',
    'can',
    'you',
    'show',
    'me',
    'some',
  ]);
  return normalizeQuery(text)
    .split(/\s+/)
    .filter((token) => token && !stop.has(token));
}

function normalizeQuery(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
