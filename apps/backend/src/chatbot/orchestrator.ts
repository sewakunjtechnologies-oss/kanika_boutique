import { randomUUID } from 'node:crypto';
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
import { downloadMedia, downloadMediaToBuffer, sendImage, sendInteractiveButtons, sendInteractiveList, sendText } from '../whatsapp/client';
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
  FULL_ADDRESS_CORRECTION_MESSAGE,
  FULL_ADDRESS_QUESTION_MESSAGE,
  NAME_QUESTION_MESSAGE,
  transition,
  unavailableSizeMessage,
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
import {
  FREE_SIZE_CANONICAL,
  FREE_SIZE_DISPLAY,
  pickFreeSizeVariant,
  resolveProductSizeMode,
} from './sizeMode';
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
} from './pausedResume';
import { handleSupportReply } from './supportNudge';
import { escalateToOwner } from './escalation';

// Customer-facing line shown when the customer taps NO on the "Confirm product"
// prompt — a brief human hand-off; the bot does NOT loop into another guess.
const TEAM_HANDOFF_MESSAGE = 'Our team will help you with this shortly.';

// Only these inbound message types drive the product/order flow. Everything else
// (audio, video, document, sticker, location, reaction, contacts, order, system,
// unsupported) is a non-product attachment → ignored, no matching, no nudge.
const PRODUCT_FLOW_INBOUND_TYPES: ReadonlySet<IncomingMessage['type']> = new Set([
  'text',
  'image',
  'interactive',
  'button',
]);

const HUMAN_TAKEOVER_MS = 6 * 60 * 60 * 1000;
const NEW_PRODUCT_AFTER_CANCEL_MESSAGE = 'Sure. Please send the new product photo or article number.';
const PRODUCT_MATCH_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

interface OrchestratorInput {
  conversationId: string;
  customerId: string;
  customerWhatsappNumber: string;
  receiverPhoneNumberId?: string | null;
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

  if (
    event.type === 'TEXT' &&
    conv.state !== ConversationState.AWAITING_PAYMENT &&
    conv.state !== ConversationState.AWAITING_PAYMENT_SCREENSHOT
  ) {
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

  // 2. Only IMAGE (product photos), TEXT, and interactive/button replies drive the
  // order flow. Every other inbound type — voice notes, videos, DOCUMENTS (e.g. an
  // .apk), stickers, locations, reactions, contacts, etc. — is a NON-PRODUCT
  // attachment: never run product matching and never send the "send a photo first"
  // nudge. Ignore silently (message is already stored for the dashboard). This is
  // strictly about file/media types, not about TEXT content.
  if (!PRODUCT_FLOW_INBOUND_TYPES.has(input.message.type)) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { intent: Intent.PERSONAL_CHAT },
    });
    botLog('INBOUND_NON_PRODUCT_IGNORED', { conversationId: conv.id, messageType: input.message.type });
    logger.info(
      { conversationId: conv.id, messageType: input.message.type },
      'non-product inbound (not image/text/interactive) — no matching, no reply',
    );
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

  const statePriorityHandled = await handleStatePriorityInput(input, conv, event);
  if (statePriorityHandled) return;

  // LATEST PHOTO WINS: a new product photo always starts a fresh matching flow
  // and hard-resets any incomplete order in progress — EXCEPT while we are
  // waiting for a payment screenshot, where an image is the payment proof, not
  // a product photo (handled by the state machine below).
  if (
    event.type === 'IMAGE' &&
    conv.state !== ConversationState.AWAITING_PAYMENT &&
    conv.state !== ConversationState.AWAITING_PAYMENT_SCREENSHOT &&
    conv.state !== ConversationState.AWAITING_VERIFICATION
  ) {
    await processInboundProductImage(input, event.mediaId, extractRequestedSize(event.caption ?? ''));
    return;
  }

  const catalogOptionsHandled = await handleCatalogOptionsIntent(input, conv, event);
  if (catalogOptionsHandled) return;

  // 4. Handle FAQs/cross-questions before asking the state machine to consume
  // the message as the next order answer.
  const questionHandled = await handleQuestion(input, conv, event);
  if (questionHandled) return;

  const productConfirmationHandled = await handleProductConfirmationInput(input, conv, event);
  if (productConfirmationHandled) return;

  // Size-specific stock is verified only here, AFTER the customer chooses a size.
  const sizeSelectionHandled = await handleSizeSelectionInput(input, conv, event);
  if (sizeSelectionHandled) return;

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

  // A NEW product photo after a cancel starts a fresh order flow DIRECTLY (match →
  // confirm) — never the intrusive "previous order cancelled / start fresh?" prompt.
  // Clear the pause + human takeover and run the matcher on the new photo. Non-image
  // inputs still go through the cancel/team/resume handling below (unchanged).
  if (event.type === 'IMAGE') {
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
    emitToDashboard('takeover_changed', {
      conversationId: conv.id,
      humanTakeover: false,
      freshImageStart: true,
    });
    await processInboundProductImage(input, event.mediaId, extractRequestedSize(event.caption ?? ''));
    return true;
  }

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
  const previousState = conv.state;

  if (conv.state === ConversationState.AWAITING_SIZE) {
    if (event.type === 'IMAGE') return false;
    botLog('STATE_PRIORITY_ROUTE', {
      conversationId: conv.id,
      state: conv.state,
      eventType: event.type,
      route: 'size_selection',
    });
    if (shouldStateMachineHandleControlText(conv.state, event, ctx)) {
      const routed = await runTransitionAndPersist(input, conv, statePriorityControlEvent(event));
      logTurnCompleted(input, previousState, routed.result.nextState, event, 'state_control_command', routed.replyCount);
      return true;
    }
    const handled = await handleSizeSelectionInput(input, conv, event);
    if (handled) return true;
    const routed = await runTransitionAndPersist(input, conv, event);
    logTurnCompleted(input, previousState, routed.result.nextState, event, 'size_reprompt', routed.replyCount);
    return true;
  }

  if (conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION) {
    if (event.type === 'IMAGE') return false;
    botLog('STATE_PRIORITY_ROUTE', {
      conversationId: conv.id,
      state: conv.state,
      eventType: event.type,
      route: 'product_match_confirmation',
    });
    const handled = await handleProductConfirmationInput(input, conv, event);
    if (handled) return true;
    const routed = await runTransitionAndPersist(input, conv, event);
    logTurnCompleted(input, previousState, routed.result.nextState, event, 'product_confirmation_reprompt', routed.replyCount);
    return true;
  }

  if (conv.state === ConversationState.AWAITING_NEW_PRODUCT) {
    if (event.type === 'TEXT' && !shouldStateMachineHandleControlText(conv.state, event, ctx)) {
      const matched = await findProductByText(event.body);
      if (matched) {
        await beginOrderFromProduct(input, matched.id, extractRequestedSize(event.body), ctx);
        return true;
      }
    }
    botLog('STATE_PRIORITY_ROUTE', {
      conversationId: conv.id,
      state: conv.state,
      eventType: event.type,
      route: 'awaiting_new_product',
    });
    const routed = await runTransitionAndPersist(input, conv, statePriorityControlEvent(event));
    logTurnCompleted(input, previousState, routed.result.nextState, event, 'awaiting_new_product', routed.replyCount);
    return true;
  }

  if (shouldStateMachineHandleControlText(conv.state, event, ctx)) {
    botLog('STATE_PRIORITY_ROUTE', {
      conversationId: conv.id,
      state: conv.state,
      eventType: event.type,
      route: 'control_command',
    });
    const routed = await runTransitionAndPersist(input, conv, statePriorityControlEvent(event));
    logTurnCompleted(input, previousState, routed.result.nextState, event, 'state_control_command', routed.replyCount);
    return true;
  }

  if (isExpectedStateReply(conv.state, event)) {
    botLog('STATE_PRIORITY_ROUTE', {
      conversationId: conv.id,
      state: conv.state,
      eventType: event.type,
      route: 'expected_state_reply',
    });
    const routed = await runTransitionAndPersist(input, conv, event);
    logTurnCompleted(input, previousState, routed.result.nextState, event, stateConsumedBy(previousState), routed.replyCount);
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
  if (/^(menu|help|options|agent|human|didi|owner)$/i.test(event.body.trim()) && state !== ConversationState.IDLE) return true;
  return false;
}

function statePriorityControlEvent(event: ChatEvent): ChatEvent {
  if (event.type !== 'TEXT') return event;
  const text = event.body.trim();
  if (/^(cancel|reset|stop|rd|cnl)$/i.test(text)) return { type: 'META_CANCEL' };
  if (/^(menu|help|options)$/i.test(text)) return { type: 'META_MENU' };
  if (/^(agent|human|didi|owner)$/i.test(text)) return { type: 'META_AGENT' };
  return event;
}

function isExpectedStateReply(state: ConversationState, event: ChatEvent): boolean {
  switch (state) {
    case ConversationState.AWAITING_NAME:
    case ConversationState.AWAITING_ADDRESS:
    case ConversationState.AWAITING_PINCODE:
      return event.type === 'TEXT';
    case ConversationState.AWAITING_PAYMENT:
    case ConversationState.AWAITING_PAYMENT_SCREENSHOT:
      return event.type === 'IMAGE';
    case ConversationState.AWAITING_VERIFICATION:
      return event.type === 'TEXT' || event.type === 'IMAGE';
    default:
      return false;
  }
}

function stateConsumedBy(state: ConversationState): string {
  switch (state) {
    case ConversationState.AWAITING_NAME:
      return 'name_entry';
    case ConversationState.AWAITING_ADDRESS:
    case ConversationState.AWAITING_PINCODE:
      return 'address_entry';
    case ConversationState.AWAITING_PAYMENT:
    case ConversationState.AWAITING_PAYMENT_SCREENSHOT:
      return 'payment_screenshot';
    case ConversationState.AWAITING_VERIFICATION:
      return 'verification_wait';
    default:
      return 'state_priority';
  }
}

function isProductChangeFlowState(state: ConversationState): boolean {
  return ([
    ConversationState.AWAITING_PRODUCT_CONFIRMATION,
    ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION,
    ConversationState.AWAITING_SIZE,
    ConversationState.AWAITING_QTY,
    ConversationState.AWAITING_NAME,
    ConversationState.AWAITING_ADDRESS,
    ConversationState.AWAITING_PINCODE,
    ConversationState.AWAITING_PAYMENT,
    ConversationState.AWAITING_PAYMENT_SCREENSHOT,
  ] as ConversationState[]).includes(state);
}

function isAmbiguousCancelFlowState(state: ConversationState): boolean {
  return ([
    ConversationState.AWAITING_PRODUCT_CONFIRMATION,
    ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION,
    ConversationState.AWAITING_NEW_PRODUCT,
    ConversationState.AWAITING_SIZE,
    ConversationState.AWAITING_QTY,
    ConversationState.AWAITING_NAME,
    ConversationState.AWAITING_ADDRESS,
    ConversationState.AWAITING_PINCODE,
    ConversationState.AWAITING_PAYMENT,
    ConversationState.AWAITING_PAYMENT_SCREENSHOT,
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
): Promise<{ result: ReturnType<typeof transition>; replyCount: number }> {
  let result = transition(conv.state, event, readOrderContext(conv.contextJson));
  const replyCount = countPlannedReplies(result.actions);
  result = await executeActions(input, conv, result);
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { state: result.nextState, contextJson: result.context as never },
  });
  return { result, replyCount };
}

function countPlannedReplies(actions: Action[]): number {
  return actions.filter((action) => (
    action.type === 'SEND_TEXT' ||
    action.type === 'SEND_BUTTONS' ||
    action.type === 'SEND_LIST'
  )).length;
}

function logTurnCompleted(
  input: OrchestratorInput,
  previousState: ConversationState,
  nextState: ConversationState,
  event: ChatEvent,
  consumedBy: string,
  replyCount: number,
  silentReason: string | null = null,
): void {
  botLog('ORCHESTRATOR_TURN_COMPLETED', {
    conversationId: input.conversationId,
    previousState,
    nextState,
    eventType: event.type,
    consumedBy,
    replyCount,
    silentReason,
  });
}

async function sendLoggedText(to: string, body: string): Promise<void> {
  botLog('AI_REPLY_GENERATED', {
    source: 'template',
    channel: 'text',
    preview: body.slice(0, 200),
  });
  await sendText(to, body);
}

async function handleCatalogOptionsIntent(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (event.type !== 'TEXT') return false;
  const ctx = readOrderContext(conv.contextJson);
  if (shouldSkipGenericCatalogIntent(conv.state, event.body)) return false;
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

function shouldSkipGenericCatalogIntent(state: ConversationState, text: string): boolean {
  const deterministicStates = ([
    ConversationState.AWAITING_SIZE,
    ConversationState.AWAITING_NAME,
    ConversationState.AWAITING_ADDRESS,
    ConversationState.AWAITING_PINCODE,
    ConversationState.AWAITING_PAYMENT,
    ConversationState.AWAITING_PAYMENT_SCREENSHOT,
    ConversationState.AWAITING_VERIFICATION,
  ] as ConversationState[]);
  if (!deterministicStates.includes(state)) return false;
  if (/^(cancel|cancel order|change product|new product|agent|human|menu|help|options)$/i.test(text.trim())) {
    return false;
  }
  return true;
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
    PRODUCT_FIRST_MESSAGE,
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
    // takeover send-guard. The photo is acknowledged, then either auto-matched,
    // sent for customer confirmation, or given a clearer-photo fallback.
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
      const { buffer, mimeType } = await downloadMediaToBuffer(msg.image.id);
      return {
        imageBase64: buffer.toString('base64'),
        imageMediaType: normalizeMime(mimeType),
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
            // No alternatives, no product lists — just a neutral message.
            await sendText(to, `Sorry, the size ${result.context.size ?? ''} is currently out of stock.`);
            result = { ...result, nextState: ConversationState.IDLE, context: {} };
            break;
          }
          // WhatsApp orders are always exactly one piece — enforce quantity 1.
          const created = await createOrderFromContext({
            customerId: input.customerId,
            ctx: { ...result.context, qty: 1 },
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
          // Payment: send the shop QR image with the payable amount. No UPI ID,
          // no follow-up message — stay silent until the screenshot arrives.
          await sendPaymentQr(to, created.orderNumber, created.total);
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
            result = { ...result, nextState: ConversationState.AWAITING_PAYMENT_SCREENSHOT };
            await sendText(to, 'I could not find an active unpaid order. Please type "menu" to start again or "agent" for help.');
            break;
          }
          let downloaded: Awaited<ReturnType<typeof downloadMedia>>;
          try {
            downloaded = await downloadMedia(action.mediaId);
          } catch (err) {
            logger.error({ err, orderId: order.id }, 'payment screenshot download failed');
            queue.length = 0;
            result = { ...result, nextState: ConversationState.AWAITING_PAYMENT_SCREENSHOT };
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
                paymentScreenshotMediaId: action.mediaId,
                paymentSubmittedAt: new Date(),
                paymentCustomerWaId: input.customerWhatsappNumber,
                paymentReceiverPhoneId: input.receiverPhoneNumberId ?? null,
                paymentExtractedAmount: extractedAmount !== null
                  ? new Prisma.Decimal(extractedAmount)
                  : null,
                paymentExtractedUtr: extractedUtr,
                paymentExtractedReceiver: extractedReceiver,
                paymentLooksLegitimate: extraction.looksLegitimate,
              },
            });
            emitToDashboard('payment_received', { orderId: order.id });
            await createPaymentReviewNotification(order.id, order.orderNumber, extractedUtr, warnings);
            await notifyAdminsOfPendingPayment(input, order, result.context, extractedUtr);
          } catch (err) {
            logger.error({ err, orderId: order.id }, 'payment extraction failed');
            await prisma.order.update({
              where: { id: order.id },
              data: {
                status: OrderStatus.PAYMENT_REVIEW,
                paymentScreenshotUrl: downloaded.storedPath,
                paymentScreenshotMediaId: action.mediaId,
                paymentSubmittedAt: new Date(),
                paymentCustomerWaId: input.customerWhatsappNumber,
                paymentReceiverPhoneId: input.receiverPhoneNumberId ?? null,
                paymentExtractedAmount: null,
                paymentExtractedUtr: null,
                paymentExtractedReceiver: null,
                paymentLooksLegitimate: false,
              },
            });
            emitToDashboard('payment_received', { orderId: order.id, extractionFailed: true });
            await createPaymentReviewNotification(order.id, order.orderNumber, null, ['payment_extraction_failed']);
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

async function createPaymentReviewNotification(
  orderId: string,
  orderNumber: string,
  utr: string | null,
  warnings: string[],
): Promise<void> {
  try {
    await prisma.dashboardNotification.create({
      data: {
        type: 'PAYMENT_AWAITING_APPROVAL',
        title: `Payment awaiting approval for order #${orderNumber}`,
        body: utr ? `UTR/reference: ${utr}` : 'Payment screenshot received.',
        entityType: 'ORDER',
        entityId: orderId,
        orderId,
        metadata: {
          orderNumber,
          utr,
          warnings,
        } as never,
      },
    });
  } catch (err) {
    logger.warn({ err, orderId }, 'failed to persist payment dashboard notification');
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
      // Silent flow: download + match the recent photo, then send at most one
      // reply only after a decision. No acknowledgement before matching.
      logger.info({ conversationId: input.conversationId }, 'using recent image context');
      const outcome = await runProductMatchOutcome(recentMediaId);
      await respondToProductMatchOutcome(input, outcome, extractRequestedSize(text), recentMediaId);
      return true;
    }
  }

  const matched = await findProductByText(text);
  if (!matched) {
    await sendText(
      input.customerWhatsappNumber,
      'Please send the product photo so I can check availability.',
    );
    return true;
  }
  await beginOrderFromProduct(input, matched.id, extractRequestedSize(text));
  return true;
}

/**
 * Normalize a YES/NO confirmation tap. Matches our button id `product_confirm_yes`
 * and tolerant variants (YES, yes, confirm_yes, PRODUCT_CONFIRM_YES). Returns null
 * for a real product-list selection (`product_<id>`/`match_<id>`/`alt_<id>`) so it
 * is never mistaken for a confirmation.
 */
function confirmButtonDecision(event: ChatEvent): 'yes' | 'no' | null {
  if (event.type !== 'BUTTON_REPLY' && event.type !== 'LIST_REPLY') return null;
  const id = (event.id ?? '').trim().toLowerCase();
  const token = id.replace(/^product_/, '');
  if (token === 'confirm_yes' || token === 'yes') return 'yes';
  if (token === 'confirm_no' || token === 'no') return 'no';
  // Title fallback only when the id carries no product reference.
  if (!id || id === 'yes' || id === 'no') {
    const title = (event.title ?? '').trim().toLowerCase();
    if (title === 'yes') return 'yes';
    if (title === 'no') return 'no';
  }
  return null;
}

/** Sort sizes numerically (38,40,42,44,46), falling back to lexicographic for letter sizes (S,M,L). */
function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    if (Number.isFinite(na)) return -1;
    if (Number.isFinite(nb)) return 1;
    return a.localeCompare(b);
  });
}

async function handleProductConfirmationInput(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (
    conv.state !== ConversationState.AWAITING_PRODUCT_CONFIRMATION &&
    conv.state !== ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION
  ) {
    return false;
  }

  const ctx = (conv.contextJson as OrderContext) ?? {};
  if (conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION && isExpiredCandidateContext(ctx)) {
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: {
        state: ConversationState.AWAITING_NEW_PRODUCT,
        contextJson: rejectedProductContext({ ...ctx, productId: ctx.candidateProductId ?? ctx.productId }) as never,
      },
    });
    await sendText(input.customerWhatsappNumber, 'This product confirmation expired. Please send the product photo or article number again.');
    return true;
  }

  const text =
    event.type === 'TEXT'
      ? event.body.trim()
      : event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY'
        ? event.title
        : '';

  // Handle YES/NO confirmation FIRST so `product_confirm_yes`/`product_confirm_no`
  // are never mistaken for a `product_<id>` list selection (the prefix collision
  // that produced a bogus "confirm_yes" product id and "This is not available.").
  const confirmDecision = confirmButtonDecision(event);
  if (confirmDecision === 'yes') {
    const selectedProductId = conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION
      ? ctx.candidateProductId
      : ctx.productId;
    botLog('PRODUCT_CONFIRMATION_RECEIVED', {
      conversationId: input.conversationId,
      candidateProductId: ctx.candidateProductId ?? null,
      selectedProductId: selectedProductId ?? null,
      decision: 'yes',
    });
    if (!selectedProductId) {
      await sendText(input.customerWhatsappNumber, PRODUCT_FIRST_MESSAGE);
      return true;
    }
    // Keep candidateProductId until the product is loaded; beginOrderFromProduct
    // persists productId (the selected product) and drops the candidate fields.
    await beginOrderFromProduct(input, selectedProductId, ctx.requestedSize ?? extractRequestedSize(text), {
      ...ctx,
      productId: selectedProductId,
    });
    return true;
  }
  if (confirmDecision === 'no') {
    botLog('PRODUCT_CONFIRMATION_RECEIVED', {
      conversationId: input.conversationId,
      candidateProductId: ctx.candidateProductId ?? null,
      selectedProductId: null,
      decision: 'no',
    });
    if (conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION) {
      await rejectCandidateProductMatch(input, ctx);
    } else {
      await askForNewProductAfterRejection(input, ctx);
    }
    return true;
  }

  // Real product-list selection (product_<id> / match_<id> / alt_<id>) — never confirm_*.
  if (
    (event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') &&
    (event.id.startsWith('match_') ||
      event.id.startsWith('alt_') ||
      (event.id.startsWith('product_') && !event.id.startsWith('product_confirm_')))
  ) {
    const productId = event.id.replace(/^(match_|product_|alt_)/, '');
    await beginOrderFromProduct(input, productId, extractRequestedSize(text), ctx);
    return true;
  }

  if (event.type === 'TEXT') {
    if (/^(yes|y|haan|han|ha|ok|okay|correct|same|this|yeh|ye)$/i.test(text)) {
      const productId = conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION
        ? ctx.candidateProductId
        : ctx.productId;
      if (!productId) {
        await sendText(input.customerWhatsappNumber, PRODUCT_FIRST_MESSAGE);
        return true;
      }
      await beginOrderFromProduct(input, productId, ctx.requestedSize ?? extractRequestedSize(text), {
        ...ctx,
        productId,
      });
      return true;
    }
    if (/^(no|n|nahi|nahin|wrong|not this|dusra|alag)$/i.test(text)) {
      if (conv.state === ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION) {
        await rejectCandidateProductMatch(input, ctx);
      } else {
        await askForNewProductAfterRejection(input, ctx);
      }
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

async function rejectCandidateProductMatch(input: OrchestratorInput, ctx: OrderContext): Promise<void> {
  // CASE 2 — the AI matched the WRONG product and the customer tapped NO. Clear the
  // candidate, escalate to the owner (the AI mis-matched; a human handles it), and
  // give the customer a brief hand-off line. Never loop the bot into another guess
  // (no alternatives, no product lists, no re-match).
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { state: ConversationState.AWAITING_NEW_PRODUCT, contextJson: {} },
  });
  await escalateToOwner({
    conversationId: input.conversationId,
    customerWhatsappNumber: input.customerWhatsappNumber,
    reason: 'CUSTOMER_REJECTED',
    imageUrl: ctx.candidateImageUrl ?? null,
  });
  await sendText(input.customerWhatsappNumber, TEAM_HANDOFF_MESSAGE);
}

function isExpiredCandidateContext(ctx: OrderContext): boolean {
  if (!ctx.candidateCreatedAt) return false;
  const createdAt = Date.parse(ctx.candidateCreatedAt);
  if (!Number.isFinite(createdAt)) return true;
  return Date.now() - createdAt > PRODUCT_MATCH_CONFIRMATION_TIMEOUT_MS;
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
  _size: string | null,
): Promise<void> {
  // Approved policy: never send numbered product lists, alternatives or
  // "Reply with the product number". Stay silent and wait for a new photo.
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_NEW_PRODUCT,
      contextJson: compactOrderContext(rejectedProductContext(ctx)) as never,
    },
  });
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

async function _findAvailableProductOptions({
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
  flowVersion?: number,
): Promise<void> {
  const threshold = env.IMAGE_MATCH_THRESHOLD;
  const score = outcome?.confidence ?? 0;

  if (outcome?.matchedProductId && score >= threshold) {
    // Only a hash-identical EXACT match (or an AI-verified non-EXACT match) is
    // safe to auto-confirm. Every other match routes to a one-tap confirmation
    // gate ("Is this the one you want?") instead of silently creating an order
    // for a possibly-wrong product. autoConfirm is decided by the matcher.
    if (outcome.autoConfirm) {
      logImageMatchDecision(input, outcome, 'MATCHED', 'auto_confirm');
      await beginOrderFromProduct(input, outcome.matchedProductId, requestedSize, {
        activeFlowVersion: flowVersion,
        activeMediaId: sourceMediaId ?? undefined,
        activeProductMediaId: sourceMediaId ?? undefined,
        lastMatchedImageMediaId: sourceMediaId ?? undefined,
        matchConfidence: score,
      });
      return;
    }

    const candidate =
      outcome.candidates.find((c) => c.productId === outcome.matchedProductId) ?? outcome.candidates[0];
    if (candidate) {
      const asked = await askCandidateProductMatchConfirmation(
        input,
        candidate,
        requestedSize,
        sourceMediaId,
        flowVersion,
      );
      if (asked) {
        logImageMatchDecision(input, outcome, 'MATCHED', 'candidate_confirmation_gate');
        return;
      }
    }
    // Candidate unavailable/inactive → fall through to silent no-match.
  }

  // Below 0.50 / no candidate / inactive product: send the customer ABSOLUTELY
  // NOTHING (no fallback, menu, "press start" or catalog/FAQ). Silence to the
  // customer, but a logged trace + a dashboard alert so the boutique team can see
  // an unmatched photo arrived and may want to reply by hand.
  logImageMatchDecision(input, outcome, 'SILENT_NO_MATCH', score < threshold ? 'below_threshold' : 'no_clear_match');
  emitToDashboard('image_unmatched', {
    conversationId: input.conversationId,
    score,
    hasCandidate: Boolean(outcome?.candidates?.[0]),
    needsHumanReply: true,
  });
  // CASE 1 — no confident match: stay SILENT to the customer, but escalate to the
  // owner (debounced WhatsApp template + always-on dashboard queue) so the tail is
  // handled by a human. Never blocks the (silent) flow.
  await escalateToOwner({
    conversationId: input.conversationId,
    customerWhatsappNumber: input.customerWhatsappNumber,
    reason: 'NO_MATCH',
  });
  // Intentionally send nothing to the customer.
}

/**
 * Sends the single minimal candidate-confirmation message: the matched inventory
 * product photo with a neutral "Confirm product" body and YES/NO buttons. No
 * description, stock, scores, alternatives or product lists. Returns false (to
 * stay silent) when the product is missing/inactive or the flow went stale.
 */
async function askCandidateProductMatchConfirmation(
  input: OrchestratorInput,
  candidate: ProductMatchCandidate,
  requestedSize: string | null,
  sourceMediaId: string | null,
  flowVersion?: number,
): Promise<boolean> {
  const availability = await getProductAvailability(candidate.productId);
  if (!availability || !availability.isActive) return false;

  const availableSizes = availability.variants.filter((v) => v.stock > 0).map((v) => v.size);
  const candidateContext: OrderContext = compactOrderContext({
    activeFlowVersion: flowVersion,
    activeMediaId: sourceMediaId ?? undefined,
    candidateProductId: candidate.productId,
    candidateProductName: availability.name || candidate.name,
    candidateProductSku: availability.sku || candidate.sku,
    candidateImageUrl: availability.imageUrl ?? candidate.imageUrl,
    candidateTopScore: candidate.confidence,
    candidateCreatedAt: new Date().toISOString(),
    requestedSize: requestedSize ?? undefined,
    availableSizes,
    lastMatchedImageMediaId: sourceMediaId ?? undefined,
    lastImageUsable: true,
    awaitingNewProduct: false,
    productRejected: false,
    lastMatchedProductRejected: false,
  });

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: {
      state: ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION,
      intent: Intent.ORDER_INTENT,
      contextJson: candidateContext as never,
    },
  });

  // One message: inventory photo header + minimal neutral body + YES/NO only.
  const imageLink = toPublicImageLink(availability.imageUrl ?? candidate.imageUrl);
  await sendInteractiveButtons(
    input.customerWhatsappNumber,
    'Confirm product',
    [
      { id: 'product_confirm_yes', title: 'YES' },
      { id: 'product_confirm_no', title: 'NO' },
    ],
    imageLink ? { headerImageUrl: imageLink } : {},
  );

  emitToDashboard('image_match_candidate', {
    conversationId: input.conversationId,
    productId: candidate.productId,
    score: candidate.confidence,
  });
  return true;
}

/**
 * Verify the customer's chosen size against LIVE inventory (the only point where
 * size-specific stock is checked). On stock → advance to name (quantity 1, no
 * decrement). On a now-unavailable size → short message + remaining sizes.
 */
async function handleSizeSelectionInput(
  input: OrchestratorInput,
  conv: Conversation,
  event: ChatEvent,
): Promise<boolean> {
  if (conv.state !== ConversationState.AWAITING_SIZE) return false;
  const previousState = conv.state;
  const ctx = readOrderContext(conv.contextJson);
  const activeProductId = ctx.productId ?? ctx.selectedProductId;

  let size: string | null = null;
  if ((event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') && event.id.startsWith('size_')) {
    size = event.id.slice('size_'.length);
  } else if (event.type === 'TEXT') {
    const candidate = event.body.trim().toUpperCase();
    if (/^[A-Z0-9]{1,6}$/.test(candidate)) size = candidate;
  }
  if (!size) return false; // not a size reply — let the reducer re-prompt

  if (!activeProductId) {
    botLog('SIZE_SELECTION_CONTEXT_MISSING', {
      conversationId: conv.id,
      state: conv.state,
      hasProductId: Boolean(ctx.productId),
      hasSelectedProductId: Boolean(ctx.selectedProductId),
      availableSizes: ctx.availableSizes ?? [],
      activeFlowId: ctx.activeFlowId ?? null,
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        state: ConversationState.AWAITING_NEW_PRODUCT,
        contextJson: {
          ...ctx,
          awaitingNewProduct: true,
          lastImageUsable: false,
        } as never,
      },
    });
    await sendLoggedText(input.customerWhatsappNumber, PRODUCT_FIRST_MESSAGE);
    logTurnCompleted(input, previousState, ConversationState.AWAITING_NEW_PRODUCT, event, 'size_context_missing', 1);
    return true;
  }

  const availability = await getProductAvailability(activeProductId);
  if (!availability || !availability.isActive) {
    await prisma.conversation.update({
      where: { id: conv.id },
      data: { state: ConversationState.IDLE, contextJson: {} },
    });
    await sendLoggedText(input.customerWhatsappNumber, 'This product is currently unavailable.');
    logTurnCompleted(input, previousState, ConversationState.IDLE, event, 'size_selection', 1);
    return true;
  }

  const inStockVariants = availability.variants.filter((v) => v.stock > 0);
  const availableSizes = sortSizes([...new Set(inStockVariants.map((v) => v.size))]);
  const chosen = inStockVariants.find((v) => v.size.toUpperCase() === size!.toUpperCase());

  if (!chosen) {
    botLog('SIZE_SELECTION', {
      conversationId: conv.id,
      productId: activeProductId,
      requestedSize: size,
      decision: 'size_unavailable',
      availableSizes,
    });
    await prisma.conversation.update({
      where: { id: conv.id },
      data: {
        state: ConversationState.AWAITING_SIZE,
        contextJson: {
          ...ctx,
          productId: activeProductId,
          selectedProductId: activeProductId,
          productName: ctx.productName ?? availability.name,
          productPrice: Number(availability.basePrice),
          unitPrice: Number(availability.basePrice),
          availableSizes,
        } as never,
      },
    });
    if (availableSizes.length === 0) {
      await sendLoggedText(input.customerWhatsappNumber, 'This product is currently unavailable.');
      logTurnCompleted(input, previousState, ConversationState.AWAITING_SIZE, event, 'size_selection', 1);
      return true;
    }
    await sendLoggedText(input.customerWhatsappNumber, unavailableSizeMessage(availableSizes));
    logTurnCompleted(input, previousState, ConversationState.AWAITING_SIZE, event, 'size_selection', 1);
    return true;
  }

  botLog('SIZE_SELECTION', {
    conversationId: conv.id,
    productId: activeProductId,
    requestedSize: chosen.size,
    decision: 'in_stock',
  });
  // Stock confirmed — do NOT decrement here (reservation/deduction happens later).
  await prisma.conversation.update({
    where: { id: conv.id },
    data: {
      state: ConversationState.AWAITING_NAME,
      contextJson: {
        ...ctx,
        productId: activeProductId,
        selectedProductId: activeProductId,
        productName: ctx.productName ?? availability.name,
        productPrice: Number(availability.basePrice),
        unitPrice: Number(availability.basePrice),
        availableSizes,
        variantId: chosen.id,
        size: chosen.size,
        selectedSize: chosen.size,
        qty: 1,
      } as never,
    },
  });
  await sendLoggedText(input.customerWhatsappNumber, NAME_QUESTION_MESSAGE);
  logTurnCompleted(input, previousState, ConversationState.AWAITING_NAME, event, 'size_selection', 1);
  return true;
}

async function beginOrderFromProduct(
  input: OrchestratorInput,
  productId: string,
  requestedSize: string | null,
  previousContext: OrderContext = {},
): Promise<void> {
  // Load the product with ALL its active size variants and per-size stock.
  // The product is available if ANY active variant has stock > 0 — never gated
  // on a selected size or a product-level quantity.
  const availability = await getProductAvailability(productId);
  if (!availability || !availability.isActive) {
    botLog('PRODUCT_CONFIRMATION_RECEIVED', {
      conversationId: input.conversationId,
      candidateProductId: previousContext.candidateProductId ?? null,
      selectedProductId: productId,
      variantCount: 0,
      availableVariantCount: 0,
      availableSizes: [],
      decision: 'unavailable',
    });
    await sendText(input.customerWhatsappNumber, 'This product is currently unavailable.');
    return;
  }

  const availableVariants = availability.variants.filter((v) => v.stock > 0);
  const availableSizes = sortSizes([...new Set(availableVariants.map((v) => v.size))]);
  const resolvedSizeMode = resolveProductSizeMode({ category: availability.category });

  botLog('PRODUCT_SIZE_MODE_RESOLVED', {
    conversationId: input.conversationId,
    productId: availability.id,
    category: availability.category,
    sizeMode: resolvedSizeMode.sizeMode,
    requiresSizeSelection: resolvedSizeMode.requiresSizeSelection,
    reason: resolvedSizeMode.reason,
  });

  botLog('PRODUCT_CONFIRMATION_RECEIVED', {
    conversationId: input.conversationId,
    candidateProductId: previousContext.candidateProductId ?? null,
    selectedProductId: availability.id,
    variantCount: availability.variants.length,
    availableVariantCount: availableVariants.length,
    availableSizes,
    sizeMode: resolvedSizeMode.sizeMode,
    decision: availableVariants.length > 0 ? 'available' : 'unavailable',
  });

  const baseContext: OrderContext = {
    productId: availability.id,
    selectedProductId: availability.id,
    productName: availability.name,
    productPrice: Number(availability.basePrice),
    unitPrice: Number(availability.basePrice),
    qty: 1,
    sizeMode: resolvedSizeMode.sizeMode,
    availableSizes,
    ...(previousContext.activeFlowVersion !== undefined ? { activeFlowVersion: previousContext.activeFlowVersion } : {}),
    ...(previousContext.activeMediaId ? { activeMediaId: previousContext.activeMediaId } : {}),
    ...(previousContext.lastMatchedImageMediaId
      ? { lastMatchedImageMediaId: previousContext.lastMatchedImageMediaId }
      : {}),
    lastImageUsable: true,
    awaitingNewProduct: false,
    productRejected: false,
  };

  // No in-stock variant: unavailable. (selectedProductId already saved above.)
  // Unstitched products are NOT marked unavailable for lacking numeric sizes —
  // availability is determined purely by whether any in-stock variant exists.
  if (availableVariants.length === 0) {
    await sendText(input.customerWhatsappNumber, 'This product is currently unavailable.');
    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { state: ConversationState.IDLE, contextJson: {} },
    });
    return;
  }

  const imageLink = toPublicImageLink(availability.imageUrl);

  // FREE_SIZE (unstitched): never ask for a size. Attach to one canonical in-stock
  // variant, store FREE_SIZE, and go straight to the customer name. Legacy numeric
  // size rows are intentionally ignored and never shown to the customer.
  if (!resolvedSizeMode.requiresSizeSelection) {
    const canonical = pickFreeSizeVariant(availableVariants);
    if (!canonical) {
      await sendText(input.customerWhatsappNumber, 'This product is currently unavailable.');
      await prisma.conversation.update({
        where: { id: input.conversationId },
        data: { state: ConversationState.IDLE, contextJson: {} },
      });
      return;
    }

    const freeSizeContext: OrderContext = {
      ...baseContext,
      // No customer-selectable sizes are ever surfaced for a free-size product.
      availableSizes: [],
      // Real variant size backs order creation / stock; FREE_SIZE is the display value.
      variantId: canonical.id,
      size: canonical.size,
      selectedSize: FREE_SIZE_CANONICAL,
    };

    await prisma.conversation.update({
      where: { id: input.conversationId },
      data: { state: ConversationState.AWAITING_NAME, contextJson: freeSizeContext as never },
    });

    botLog('UNSTITCHED_FREE_SIZE_SELECTED', {
      conversationId: input.conversationId,
      productId: availability.id,
      variantId: canonical.id,
      backingSize: canonical.size,
    });

    // Customer-facing copy intentionally omits the internal product name + article/SKU
    // (those stay on the order, contextJson and the printed label). The product photo is
    // still attached via sendImage so the customer sees what they are ordering.
    const freeSizeText =
      `Yes, it is available.\n` +
      `Price: ₹${availability.basePrice}\n` +
      `Size: ${FREE_SIZE_DISPLAY}\n\n` +
      NAME_QUESTION_MESSAGE;
    if (imageLink) {
      await sendImage(input.customerWhatsappNumber, { link: imageLink }, freeSizeText);
    } else {
      await sendText(input.customerWhatsappNumber, freeSizeText);
    }
    return;
  }

  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { state: ConversationState.AWAITING_SIZE, contextJson: baseContext as never },
  });

  // SIZED availability message — NO stock counts, NO internal name/article (kept on the
  // order + label only). Optionally lead with the inventory image.
  const availabilityText =
    `Yes, it is available.\n` +
    `Price: ₹${availability.basePrice}\n` +
    `Available sizes: ${availableSizes.join(', ')}\n\n` +
    'Please send your size.';
  if (imageLink) {
    await sendImage(input.customerWhatsappNumber, { link: imageLink }, availabilityText);
  } else {
    await sendText(input.customerWhatsappNumber, availabilityText);
  }
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
      return 'After your order details are complete, I will send the payment QR here.';
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
      ? `Yes, size ${ctx.size} is available.`
      : `Sorry, size ${ctx.size} is not available.`;
  }

  const availability = await getProductAvailability(ctx.productId);
  if (!availability) return 'This product is not available.';
  const available = availability.variants.filter((v) => v.stock > 0);
  if (available.length === 0) return 'This product is currently out of stock.';
  const sizes = sortSizes([...new Set(available.map((v) => v.size))]);
  return `Yes, it is available.\n${availability.name}\nAvailable sizes: ${sizes.join(', ')}`;
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
  _ctx: OrderContext,
): Promise<void> {
  switch (state) {
    case ConversationState.AWAITING_PRODUCT_CONFIRMATION:
      // No acknowledgement is sent for product photos under the silent-match
      // policy; stay quiet rather than implying a check is in progress.
      return;
    case ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION:
      await sendInteractiveButtons(to, 'Please confirm if the likely match is the same product.', [
        { id: 'product_confirm_yes', title: 'Yes' },
        { id: 'product_confirm_no', title: 'No' },
      ]);
      return;
    case ConversationState.AWAITING_NEW_PRODUCT:
      await sendText(to, PRODUCT_FIRST_MESSAGE);
      return;
    case ConversationState.AWAITING_SIZE:
      await sendText(to, 'Please send your size.');
      return;
    case ConversationState.AWAITING_QTY:
      await sendText(to, NAME_QUESTION_MESSAGE);
      return;
    case ConversationState.AWAITING_NAME:
      await sendText(to, NAME_QUESTION_MESSAGE);
      return;
    case ConversationState.AWAITING_ADDRESS:
      await sendText(to, FULL_ADDRESS_QUESTION_MESSAGE);
      return;
    case ConversationState.AWAITING_PINCODE:
      await sendText(to, FULL_ADDRESS_CORRECTION_MESSAGE);
      return;
    case ConversationState.AWAITING_PAYMENT:
    case ConversationState.AWAITING_PAYMENT_SCREENSHOT:
      return;
    case ConversationState.AWAITING_VERIFICATION:
      return;
    case ConversationState.IDLE:
    case ConversationState.COMPLETED:
    case ConversationState.ABANDONED:
      return;
  }
}

async function sendPaymentQr(to: string, orderNumber: string, total: number | string): Promise<void> {
  const caption = `Order #${orderNumber}\nAmount to pay: ₹${total}\n\nPlease send the payment screenshot once paid.`;
  const qrUrl = env.PAYMENT_QR_IMAGE_URL;
  if (qrUrl) {
    await sendImage(to, { link: qrUrl }, caption);
    return;
  }
  // QR not configured — send only the payable amount. Never send the UPI ID.
  logger.warn('PAYMENT_QR_IMAGE_URL not set — sending amount text without QR image');
  await sendText(to, caption);
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

function _sameSize(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

function toPublicImageLink(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) return imageUrl;
  if (imageUrl.startsWith('/')) return `${env.PUBLIC_BACKEND_URL.replace(/\/+$/, '')}${imageUrl}`;
  return null;
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
 * guards on real dashboard inventory, downloads + matches, and never creates
 * an order unless the product is auto-matched or explicitly confirmed by the
 * customer. Never throws — the webhook has already returned 200.
 */
async function processInboundProductImage(
  input: OrchestratorInput,
  mediaId: string,
  requestedSize: string | null,
): Promise<void> {
  // A new product photo is a HARD RESET of any incomplete shopping flow. We bump
  // the flow version and clear all prior product/order-in-progress state in one
  // transaction so the latest photo always wins. Completed orders are untouched.
  const flowVersion = await startFreshImageFlow(input, mediaId);

  // Never send any acknowledgement before matching completes.
  if (!(await hasSearchableInventoryImages())) {
    logImageMatchDecision(input, null, 'SILENT_NO_MATCH', 'inventory_index_empty');
    return;
  }

  const outcome = await runProductMatchOutcome(mediaId);

  // Latest-message-wins: if a newer customer message arrived while we matched,
  // discard this (possibly slow) result and send nothing.
  if (await isFlowStale(input.conversationId, flowVersion, mediaId)) {
    logImageMatchDecision(input, outcome, 'SILENT_NO_MATCH', 'stale_flow_discarded');
    return;
  }
  await respondToProductMatchOutcome(input, outcome, requestedSize, mediaId, flowVersion);
}

/**
 * Hard reset for a new product photo: clears matched/candidate product, size,
 * quantity, name, address, payment-pending and all suggestions, and bumps the
 * flow version. Returns the new flow version. Persisted in one update.
 */
async function startFreshImageFlow(input: OrchestratorInput, mediaId: string): Promise<number> {
  const conv = await prisma.conversation.findUnique({ where: { id: input.conversationId } });
  const prev = readOrderContext(conv?.contextJson);
  const flowVersion = (prev.activeFlowVersion ?? 0) + 1;
  const receivedAt = new Date(Number(input.message.timestamp) * 1000);
  const safeReceivedAt = Number.isFinite(receivedAt.getTime()) ? receivedAt : new Date();
  const freshContext: OrderContext = {
    activeFlowId: randomUUID(),
    activeFlowVersion: flowVersion,
    activeMediaId: mediaId,
    activeProductMediaId: mediaId,
    activeProductMessageId: input.message.id,
    activeProductReceivedAt: safeReceivedAt.toISOString(),
    latestInboundTimestamp: input.message.timestamp,
    latestInboundMessageId: input.message.id,
    lastMatchedImageMediaId: mediaId,
  };
  await prisma.conversation.update({
    where: { id: input.conversationId },
    data: { state: ConversationState.AWAITING_PRODUCT_CONFIRMATION, contextJson: freshContext as never },
  });
  return flowVersion;
}

/**
 * True when a newer flow has started (newer photo/message) or the active media
 * no longer matches — meaning this async result must be discarded.
 */
async function isFlowStale(conversationId: string, flowVersion: number, mediaId: string): Promise<boolean> {
  const conv = await prisma.conversation.findUnique({ where: { id: conversationId } });
  const ctx = readOrderContext(conv?.contextJson);
  if ((ctx.activeFlowVersion ?? 0) !== flowVersion) return true;
  if (ctx.activeMediaId && ctx.activeMediaId !== mediaId) return true;
  return false;
}

/**
 * Safe, token-free diagnostic log for every inbound product image. Never logs
 * access tokens or signed media URLs.
 */
function logImageMatchDecision(
  input: OrchestratorInput,
  outcome: ProductMatchOutcome | null,
  decision: 'MATCHED' | 'SILENT_NO_MATCH',
  reason: string,
): void {
  const candidates = outcome?.candidates ?? [];
  const detail = {
    whatsappMessageId: input.message.id,
    conversationId: input.conversationId,
    candidateCount: candidates.length,
    matchedProductId: outcome?.matchedProductId ?? candidates[0]?.productId ?? null,
    topSku: candidates[0]?.sku ?? null,
    topScore: outcome?.confidence ?? 0,
    secondScore: candidates[1]?.confidence ?? null,
    scoreMargin: outcome?.bestSecondMargin ?? null,
    matchType: outcome?.matchType ?? candidates[0]?.matchType ?? null,
    matcherDecisionReason: outcome?.decisionReason ?? null,
    decision,
    reason,
  };
  botLog('IMAGE_MATCH_DECISION', detail);
  botLog(decision === 'MATCHED' ? 'WHATSAPP_MATCH_REPLY_SENT' : 'WHATSAPP_SILENT_NO_MATCH', {
    whatsappMessageId: input.message.id,
    conversationId: input.conversationId,
    candidateCount: candidates.length,
    topScore: detail.topScore,
    reason,
  });
}

async function runProductMatchOutcome(mediaId: string): Promise<ProductMatchOutcome | null> {
  try {
    // Download the customer photo fully in memory — never write it to disk.
    const { buffer, mimeType } = await downloadMediaToBuffer(mediaId);
    const outcome = await matchProduct({
      imageBase64: buffer.toString('base64'),
      imageMediaType: normalizeMime(mimeType),
    });
    logger.info(
      {
        mediaId,
        matchedProductId: outcome.matchedProductId ?? null,
        confidence: outcome.confidence,
        confidenceBand: outcome.confidenceBand,
        decision: outcome.decision,
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
