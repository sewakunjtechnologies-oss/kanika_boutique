// Pure conversation state machine. Inputs (current state + event + context) →
// outputs (next state + actions). Has zero side effects; the orchestrator runs
// the actions returned here. This makes the state machine fully unit-testable.

import { ConversationState } from '@kda/db';

// =============================================================================
// Context — in-progress order being collected from the customer.
// Stored as JSON in Conversation.contextJson.
// =============================================================================

export interface OrderContext {
  orderId?: string;
  orderNumber?: string;
  botPausedReason?: 'customer_cancelled' | 'order_closed' | 'stale_order';
  pendingRestart?: {
    imageMediaId?: string;
    quotedImageMediaId?: string;
    latestImageMediaId?: string;
    caption?: string;
    text?: string;
    previousCancelledOrderId?: string;
    requestedAt: string;
  };
  attentionRequestedAt?: string;
  teamHelpRequestedAt?: string;
  resolvedAt?: string;
  productId?: string;
  productName?: string;
  productPrice?: number;
  requestedSize?: string;
  matchConfidence?: number;
  candidateProductId?: string;
  candidateProductName?: string;
  candidateProductSku?: string;
  candidateImageUrl?: string;
  candidateTopScore?: number;
  candidateSecondScore?: number;
  candidateScoreMargin?: number;
  candidateCreatedAt?: string;
  candidateProductIds?: string[];
  lastMatchedImageMediaId?: string;
  productRejected?: boolean;
  lastMatchedProductRejected?: boolean;
  lastImageUsable?: boolean;
  awaitingNewProduct?: boolean;
  rejectedProductId?: string;
  lastRejectedProductId?: string;
  rejectedImageMediaId?: string;
  cancelClarificationPending?: boolean;
  availableProductOptions?: string[];
  availableProductListShown?: boolean;
  availableProductListSize?: string;
  variantId?: string;
  size?: string;
  qty?: number;
  customerName?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  unitPrice?: number;
  subtotal?: number;
  shippingFee?: number;
  total?: number;
  /** In-stock sizes for the matched product. Set by orchestrator after product match. */
  availableSizes?: string[];
  /** Monotonic version bumped whenever a new product photo starts a fresh flow.
   * Async match results are discarded if this no longer matches (latest wins). */
  activeFlowVersion?: number;
  /** WhatsApp media ID of the photo that owns the current product-match flow. */
  activeMediaId?: string;
  activeFlowId?: string;
  latestInboundTimestamp?: string;
  activeProductMediaId?: string;
  activeProductMessageId?: string;
  activeProductReceivedAt?: string;
  selectedProductId?: string;
  selectedSize?: string;
  /** Latest processed inbound WhatsApp message id for this conversation. */
  latestInboundMessageId?: string;
}

// =============================================================================
// Events — what arrived from the customer (post-classification).
// =============================================================================

export type ChatEvent =
  | { type: 'TEXT'; body: string }
  | { type: 'IMAGE'; mediaId: string; caption?: string }
  | { type: 'BUTTON_REPLY'; id: string; title: string }
  | { type: 'LIST_REPLY'; id: string; title: string }
  | { type: 'META_CANCEL' }
  | { type: 'META_MENU' }
  | { type: 'META_AGENT' }
  | { type: 'PAYMENT_SCREENSHOT'; mediaId: string }
  | { type: 'PRODUCT_MATCH_RESULT'; productId: string | null; alternativesNeeded: boolean };

// =============================================================================
// Actions — what the orchestrator should do after the transition.
// =============================================================================

export type Action =
  | { type: 'SEND_TEXT'; body: string }
  | { type: 'SEND_BUTTONS'; body: string; buttons: { id: string; title: string }[] }
  | {
      type: 'SEND_LIST';
      body: string;
      buttonText: string;
      sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
    }
  | { type: 'RUN_PRODUCT_MATCH'; mediaId: string }
  | { type: 'RUN_PAYMENT_EXTRACTION'; mediaId: string }
  | { type: 'SUGGEST_ALTERNATIVES'; productId: string }
  | { type: 'CREATE_ORDER' }
  | { type: 'CANCEL_CONTEXT_ORDER' }
  | { type: 'NOTIFY_DASHBOARD'; event: 'order_created' | 'payment_received' }
  | { type: 'MARK_HUMAN_TAKEOVER' }
  | { type: 'RESET_CONTEXT' };

export interface TransitionResult {
  nextState: ConversationState;
  context: OrderContext;
  actions: Action[];
}

// Fallback only — used when the orchestrator hasn't populated ctx.availableSizes.
const FALLBACK_SIZES = ['S', 'M', 'L', 'XL', 'XXL'];

// Build either an interactive button list (≤3 sizes) or list (4+) prompt for size.
function buildSizePrompt(context: OrderContext, headerText: string): Action {
  const sizes = (context.availableSizes && context.availableSizes.length > 0
    ? context.availableSizes
    : FALLBACK_SIZES
  ).slice(0, 10);

  if (sizes.length <= 3) {
    return {
      type: 'SEND_BUTTONS',
      body: headerText,
      buttons: sizes.map((s) => ({ id: `size_${s}`, title: s })),
    };
  }
  return {
    type: 'SEND_LIST',
    body: headerText,
    buttonText: 'Pick size',
    sections: [
      {
        title: 'Available sizes',
        rows: sizes.map((s) => ({ id: `size_${s}`, title: s })),
      },
    ],
  };
}

// =============================================================================
// Meta-commands work at any state.
// =============================================================================

function detectMetaCommand(text: string): 'cancel' | 'menu' | 'agent' | null {
  const t = text.trim().toLowerCase();
  if (
    /^(cancel|reset|stop|rd|cnl)\b/.test(t) ||
    /\b(cancel order|order cancel|nahi chahiye|nahin chahiye|nhi chahiye|mat karo|rehne do|chhod do|chod do|not interested|no thanks)\b/.test(t)
  ) {
    return 'cancel';
  }
  if (/^(menu|help|options)\b/.test(t)) return 'menu';
  if (/^(agent|human|didi|owner)\b/.test(t)) return 'agent';
  return null;
}

export const NEW_PRODUCT_REQUEST_MESSAGE =
  'No problem. Please send the new product photo or article number you want to order.';

export const PRODUCT_REJECTED_MESSAGE =
  "No problem. I won't continue with this product. Please send another product photo or article number.";

export const CANCEL_OR_CHANGE_MESSAGE =
  'Do you want to cancel the order completely or choose another product?\nReply 1 for Cancel order, 2 for Choose another product.';

export const PRODUCT_FIRST_MESSAGE =
  "Please send the product photo or article number first, then I'll check availability.";

export function isProductChangeIntent(text: string): boolean {
  const t = normalizeIntentText(text);
  return /\b(change product|change the product|different product|another product|something else|not this|wrong product|no this is not|change item|new product|want to change the product)\b/.test(t);
}

export function isAmbiguousCancelIntent(text: string): boolean {
  return /^(cancel|cnl)$/i.test(text.trim());
}

export function isDirectCancelIntent(text: string): boolean {
  const t = normalizeIntentText(text);
  return /\b(cancel order|cancel completely|stop order|cancel this order|cancel the order|order cancel)\b/.test(t);
}

function normalizeIntentText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function metaCommandActions(cmd: 'cancel' | 'menu' | 'agent'): TransitionResult {
  switch (cmd) {
    case 'cancel':
      return {
        nextState: ConversationState.IDLE,
        context: {},
        actions: [
          { type: 'RESET_CONTEXT' },
          {
            type: 'SEND_TEXT',
            body: 'Your in-progress order has been cancelled. The bot is paused now so the boutique team can continue normally.',
          },
          { type: 'MARK_HUMAN_TAKEOVER' },
        ],
      };
    case 'menu':
      return {
        nextState: ConversationState.IDLE,
        context: {},
        actions: [
          {
            type: 'SEND_BUTTONS',
            body: 'How can I help?',
            buttons: [
              { id: 'menu_browse', title: 'Browse' },
              { id: 'menu_status', title: 'Order status' },
              { id: 'menu_agent', title: 'Talk to us' },
            ],
          },
        ],
      };
    case 'agent':
      return {
        nextState: ConversationState.IDLE,
        context: {},
        actions: [
          {
            type: 'SEND_TEXT',
            body: 'Connecting you to a human. We will reply as soon as possible — thank you for your patience.',
          },
          { type: 'MARK_HUMAN_TAKEOVER' },
        ],
      };
  }
}

// =============================================================================
// Main transition function. Pure: same inputs → same outputs.
// =============================================================================

export function transition(
  current: ConversationState,
  event: ChatEvent,
  context: OrderContext,
): TransitionResult {
  // Meta-commands override the current flow.
  if (event.type === 'META_CANCEL') return metaCommandActions('cancel');
  if (event.type === 'META_MENU') return metaCommandActions('menu');
  if (event.type === 'META_AGENT') return metaCommandActions('agent');
  if (event.type === 'TEXT') {
    if (current === ConversationState.AWAITING_PRODUCT_CONFIRMATION && isProductRejectionText(event.body)) {
      return productRejectedActions(context);
    }
    if (context.cancelClarificationPending) {
      const clarification = handleCancelClarificationReply(event.body, context);
      if (clarification) return clarification;
    }
    if (isProductChangeState(current) && isProductChangeIntent(event.body)) {
      return productChangeActions(context);
    }
    if (isAmbiguousCancelState(current) && isAmbiguousCancelIntent(event.body)) {
      return askCancelOrChange(context);
    }
    const meta = detectMetaCommand(event.body);
    if (meta) return metaCommandActions(meta);
  }

  switch (current) {
    case ConversationState.IDLE:
      return handleIdle(event, context);

    case ConversationState.AWAITING_PRODUCT_CONFIRMATION:
      return handleProductConfirmation(event, context);

    case ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION:
      return handleProductMatchConfirmation(event, context);

    case ConversationState.AWAITING_NEW_PRODUCT:
      return handleAwaitingNewProduct(event, context);

    case ConversationState.AWAITING_SIZE:
      return handleSize(event, context);

    case ConversationState.AWAITING_QTY:
      return handleQty(event, context);

    case ConversationState.AWAITING_NAME:
      return handleName(event, context);

    case ConversationState.AWAITING_ADDRESS:
      return handleAddress(event, context);

    case ConversationState.AWAITING_PINCODE:
      return handlePincode(event, context);

    case ConversationState.AWAITING_PAYMENT:
    case ConversationState.AWAITING_PAYMENT_SCREENSHOT:
      return handlePayment(event, context);

    case ConversationState.AWAITING_VERIFICATION:
      return {
        nextState: ConversationState.AWAITING_VERIFICATION,
        context,
        actions: [
          {
            type: 'SEND_TEXT',
            body: 'Your payment is being verified. We will confirm within 2 hours.',
          },
        ],
      };

    case ConversationState.COMPLETED:
    case ConversationState.ABANDONED:
      // Fresh conversation — treat like IDLE.
      return handleIdle(event, {});
  }
}

function isProductChangeState(state: ConversationState): boolean {
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

function isAmbiguousCancelState(state: ConversationState): boolean {
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

function handleCancelClarificationReply(text: string, context: OrderContext): TransitionResult | null {
  const normalized = normalizeIntentText(text);
  if (normalized === '1' || isDirectCancelIntent(text)) return metaCommandActions('cancel');
  if (normalized === '2' || isProductChangeIntent(text)) return productChangeActions(context);
  if (isAmbiguousCancelIntent(text)) return askCancelOrChange(context);
  return null;
}

function askCancelOrChange(context: OrderContext): TransitionResult {
  return {
    nextState: ConversationState.AWAITING_NEW_PRODUCT,
    context: {
      ...rejectProductContext(context),
      cancelClarificationPending: true,
    },
    actions: [{ type: 'SEND_TEXT', body: CANCEL_OR_CHANGE_MESSAGE }],
  };
}

function productChangeActions(context: OrderContext): TransitionResult {
  const actions: Action[] = [];
  if (context.orderId) actions.push({ type: 'CANCEL_CONTEXT_ORDER' });
  actions.push({ type: 'SEND_TEXT', body: NEW_PRODUCT_REQUEST_MESSAGE });
  return {
    nextState: ConversationState.AWAITING_NEW_PRODUCT,
    context: rejectProductContext(context),
    actions,
  };
}

function productRejectedActions(context: OrderContext): TransitionResult {
  return {
    nextState: ConversationState.AWAITING_NEW_PRODUCT,
    context: rejectProductContext(context),
    actions: [{ type: 'SEND_TEXT', body: PRODUCT_REJECTED_MESSAGE }],
  };
}

function rejectProductContext(context: OrderContext): OrderContext {
  return compactContext({
    productRejected: true,
    lastMatchedProductRejected: true,
    lastImageUsable: false,
    awaitingNewProduct: true,
    rejectedProductId: context.productId ?? context.rejectedProductId,
    lastRejectedProductId: context.productId ?? context.lastRejectedProductId,
    rejectedImageMediaId: context.lastMatchedImageMediaId ?? context.rejectedImageMediaId,
  });
}

function compactContext(context: OrderContext): OrderContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as OrderContext;
}

// =============================================================================
// State-specific handlers
// =============================================================================

function handleIdle(event: ChatEvent, _context: OrderContext): TransitionResult {
  if (event.type === 'IMAGE') {
    return {
      nextState: ConversationState.AWAITING_PRODUCT_CONFIRMATION,
      context: {},
      actions: [{ type: 'RUN_PRODUCT_MATCH', mediaId: event.mediaId }],
    };
  }

  if (event.type === 'PRODUCT_MATCH_RESULT') {
    // Triggered after the orchestrator ran the matcher.
    if (event.productId) {
      const nextCtx: OrderContext = {
        ..._context,
        productId: event.productId,
      };
      return {
        nextState: ConversationState.AWAITING_SIZE,
        context: nextCtx,
        actions: [buildSizePrompt(nextCtx, 'Found this match! What size?')],
      };
    }
    return {
      nextState: ConversationState.IDLE,
      context: {},
      actions: [
        {
          type: 'SEND_TEXT',
          body: "I couldn't match this to a specific item. Could you describe what you're looking for, or pick from our catalog?",
        },
      ],
    };
  }

  if (event.type === 'TEXT' || event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') {
    return {
      nextState: ConversationState.IDLE,
      context: {},
      actions: [
        {
          type: 'SEND_BUTTONS',
          body: 'Welcome! Send a product photo or pick an option below.',
          buttons: [
            { id: 'menu_browse', title: 'Browse' },
            { id: 'menu_status', title: 'Order status' },
            { id: 'menu_agent', title: 'Talk to us' },
          ],
        },
      ],
    };
  }

  return { nextState: ConversationState.IDLE, context: {}, actions: [] };
}

function handleAwaitingNewProduct(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type === 'IMAGE') {
    return {
      nextState: ConversationState.AWAITING_PRODUCT_CONFIRMATION,
      context: {
        productRejected: true,
        lastMatchedProductRejected: true,
        lastImageUsable: true,
        awaitingNewProduct: false,
        rejectedProductId: context.rejectedProductId,
        lastRejectedProductId: context.lastRejectedProductId,
        rejectedImageMediaId: context.rejectedImageMediaId,
        lastMatchedImageMediaId: event.mediaId,
      },
      actions: [{ type: 'RUN_PRODUCT_MATCH', mediaId: event.mediaId }],
    };
  }

  if (event.type === 'PRODUCT_MATCH_RESULT') {
    if (event.productId) {
      const nextCtx: OrderContext = {
        productId: event.productId,
        productRejected: false,
        lastMatchedProductRejected: false,
        lastImageUsable: true,
        awaitingNewProduct: false,
      };
      return {
        nextState: ConversationState.AWAITING_SIZE,
        context: nextCtx,
        actions: [buildSizePrompt(nextCtx, 'Found this match! What size?')],
      };
    }
    return {
      nextState: ConversationState.AWAITING_NEW_PRODUCT,
      context: rejectProductContext(context),
      actions: [{ type: 'SEND_TEXT', body: PRODUCT_FIRST_MESSAGE }],
    };
  }

  return {
    nextState: ConversationState.AWAITING_NEW_PRODUCT,
    context: rejectProductContext(context),
    actions: [{ type: 'SEND_TEXT', body: PRODUCT_FIRST_MESSAGE }],
  };
}

function handleProductConfirmation(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type === 'TEXT' && isProductRejectionText(event.body)) {
    return productRejectedActions(context);
  }

  if (event.type === 'PRODUCT_MATCH_RESULT') {
    if (event.productId) {
      const nextCtx: OrderContext = { ...context, productId: event.productId };
      return {
        nextState: ConversationState.AWAITING_SIZE,
        context: nextCtx,
        actions: [buildSizePrompt(nextCtx, 'Found this match! What size?')],
      };
    }
    return {
      nextState: ConversationState.IDLE,
      context: {},
      actions: [
        {
          type: 'SEND_TEXT',
          body: "Couldn't match that. Could you send a clearer photo or describe what you're looking for?",
        },
      ],
    };
  }
  return {
    nextState: current(ConversationState.AWAITING_PRODUCT_CONFIRMATION),
    context,
    actions: [
      {
        type: 'SEND_TEXT',
        body: 'Still looking up your photo — please wait a moment.',
      },
    ],
  };
}

function handleProductMatchConfirmation(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type === 'TEXT' && isProductRejectionText(event.body)) {
    return {
      nextState: ConversationState.AWAITING_NEW_PRODUCT,
      context: rejectProductContext({
        ...context,
        productId: context.candidateProductId ?? context.productId,
      }),
      actions: [{ type: 'SEND_TEXT', body: PRODUCT_REJECTED_MESSAGE }],
    };
  }

  if (
    event.type === 'TEXT' &&
    /^(yes|y|haan|han|ha|ok|okay|correct|same|this|yeh|ye)$/i.test(event.body.trim()) &&
    context.candidateProductId
  ) {
    const nextCtx: OrderContext = {
      ...context,
      productId: context.candidateProductId,
      productName: context.candidateProductName,
      productRejected: false,
      lastMatchedProductRejected: false,
      awaitingNewProduct: false,
      lastImageUsable: true,
    };
    return {
      nextState: ConversationState.AWAITING_SIZE,
      context: nextCtx,
      actions: [buildSizePrompt(nextCtx, 'Great. Which size would you like?')],
    };
  }

  return {
    nextState: ConversationState.AWAITING_PRODUCT_MATCH_CONFIRMATION,
    context,
    actions: [
      {
        type: 'SEND_BUTTONS',
        body: 'Please confirm if this is the same product.',
        buttons: [
          { id: 'product_confirm_yes', title: 'Yes' },
          { id: 'product_confirm_no', title: 'No' },
        ],
      },
    ],
  };
}

function isProductRejectionText(text: string): boolean {
  const t = normalizeIntentText(text);
  return /^(no|n|nahi|nahin|nope|wrong|not this|ye nahi|ye nahin|ye nahi chahiye|ye nahin chahiye|nahi chahiye|nahin chahiye)$/.test(t) ||
    /\b(not this|wrong product|no this is not|ye nahi chahiye|ye nahin chahiye|nahi chahiye|nahin chahiye)\b/.test(t);
}

function handleSize(event: ChatEvent, context: OrderContext): TransitionResult {
  let size: string | null = null;
  if ((event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') && event.id.startsWith('size_')) {
    size = event.id.slice('size_'.length);
  } else if (event.type === 'TEXT') {
    const candidate = event.body.trim().toUpperCase();
    // Accept any reasonable size token: numeric (36/38/40), letter (S/M/L/XL), 1-6 chars alphanumeric.
    if (/^[A-Z0-9]{1,6}$/.test(candidate)) size = candidate;
  }

  if (!size) {
    return {
      nextState: ConversationState.AWAITING_SIZE,
      context,
      actions: [buildSizePrompt(context, 'Please pick a size:')],
    };
  }

  // If we know the available sizes and this isn't one of them, re-prompt instead of accepting.
  if (
    context.availableSizes &&
    context.availableSizes.length > 0 &&
    !context.availableSizes.map((s) => s.toUpperCase()).includes(size.toUpperCase())
  ) {
    return {
      nextState: ConversationState.AWAITING_SIZE,
      context,
      actions: [
        buildSizePrompt(
          context,
          `Sorry, size ${size} isn't available. Available: ${context.availableSizes.join(', ')}.`,
        ),
      ],
    };
  }

  // Every WhatsApp order is exactly one piece — never ask quantity. Go straight
  // from size to the customer name.
  return {
    nextState: ConversationState.AWAITING_NAME,
    context: { ...context, size, qty: 1 },
    actions: [{ type: 'SEND_TEXT', body: 'What name should we put on the order?' }],
  };
}

function handleQty(event: ChatEvent, context: OrderContext): TransitionResult {
  void event;
  // Legacy self-heal: previous deployments could leave a conversation in
  // AWAITING_QTY. Approved production flow is quantity=1, so never ask quantity.
  return {
    nextState: ConversationState.AWAITING_NAME,
    context: { ...context, qty: 1 },
    actions: [{ type: 'SEND_TEXT', body: 'What name should we put on the order?' }],
  };
}

function handleName(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type !== 'TEXT' || event.body.trim().length < 2) {
    return {
      nextState: ConversationState.AWAITING_NAME,
      context,
      actions: [{ type: 'SEND_TEXT', body: 'Please share your full name.' }],
    };
  }
  return {
    nextState: ConversationState.AWAITING_ADDRESS,
    context: { ...context, customerName: event.body.trim() },
    actions: [
      {
        type: 'SEND_TEXT',
        body: 'Please send your complete delivery address with house/flat, street/area, city, state and 6-digit pincode in one message.',
      },
    ],
  };
}

export interface ParsedFullAddress {
  address: string;
  city: string;
  state: string;
  pincode: string;
}

/**
 * Parse a single combined address reply into street/city/state/pincode.
 * Returns null when no valid 6-digit pincode or enough detail is present.
 */
export function parseFullAddress(raw: string): ParsedFullAddress | null {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (text.length < 10) return null;
  const pincodeMatch = text.match(/\b(\d{6})\b/);
  if (!pincodeMatch) return null;
  const pincode = pincodeMatch[1] as string;

  const withoutPincode = text.replace(pincode, '').replace(/,\s*$/, '').trim();
  const parts = withoutPincode
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);

  let address = withoutPincode;
  let city = '';
  let state = '';
  if (parts.length >= 3) {
    state = parts[parts.length - 1] ?? '';
    city = parts[parts.length - 2] ?? '';
    address = parts.slice(0, parts.length - 2).join(', ');
  } else if (parts.length === 2) {
    address = parts[0] ?? '';
    const tail = (parts[1] ?? '').split(/\s+/).filter(Boolean);
    city = tail[0] ?? '';
    state = tail.slice(1).join(' ') || city;
  } else {
    const tokens = withoutPincode.split(/\s+/).filter(Boolean);
    city = tokens[tokens.length - 2] ?? tokens[0] ?? '';
    state = tokens[tokens.length - 1] ?? city;
  }

  if (!address || !city || !pincode) return null;
  return { address: address.trim(), city: city.trim(), state: (state || city).trim(), pincode };
}

function handleAddress(event: ChatEvent, context: OrderContext): TransitionResult {
  const reAsk: TransitionResult = {
    nextState: ConversationState.AWAITING_ADDRESS,
    context,
    actions: [
      {
        type: 'SEND_TEXT',
        body: 'Please send your complete delivery address with house/flat, street/area, city, state and 6-digit pincode in one message.',
      },
    ],
  };
  if (event.type !== 'TEXT') return reAsk;
  const parsed = parseFullAddress(event.body);
  if (!parsed) return reAsk;

  // Address is complete — create the order (quantity is always 1).
  return {
    nextState: ConversationState.AWAITING_PAYMENT_SCREENSHOT,
    context: {
      ...context,
      qty: 1,
      address: parsed.address,
      city: parsed.city,
      state: parsed.state,
      pincode: parsed.pincode,
    },
    actions: [{ type: 'CREATE_ORDER' }],
  };
}

function handlePincode(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type !== 'TEXT') {
    return {
      nextState: ConversationState.AWAITING_PINCODE,
      context,
      actions: [{ type: 'SEND_TEXT', body: 'Please share city, state and pincode.' }],
    };
  }
  const text = event.body.trim();
  const pincodeMatch = text.match(/\b(\d{6})\b/);
  if (!pincodeMatch) {
    return {
      nextState: ConversationState.AWAITING_PINCODE,
      context,
      actions: [{ type: 'SEND_TEXT', body: 'Please include a valid 6-digit pincode.' }],
    };
  }
  const pincode = pincodeMatch[1] as string;
  const withoutPincode = text.replace(pincode, '').replace(/,/g, '').trim();
  const tokens = withoutPincode.split(/\s+/).filter(Boolean);
  const city = tokens[0] ?? '';
  const state = tokens.slice(1).join(' ') || tokens[0] || '';

  return {
    nextState: ConversationState.AWAITING_PAYMENT_SCREENSHOT,
    context: { ...context, pincode, city, state },
    actions: [{ type: 'CREATE_ORDER' }],
  };
}

function handlePayment(event: ChatEvent, context: OrderContext): TransitionResult {
  if (event.type === 'IMAGE' || event.type === 'PAYMENT_SCREENSHOT') {
    const mediaId = event.type === 'IMAGE' ? event.mediaId : event.mediaId;
    return {
      nextState: ConversationState.AWAITING_VERIFICATION,
      context,
      actions: [
        { type: 'RUN_PAYMENT_EXTRACTION', mediaId },
        { type: 'NOTIFY_DASHBOARD', event: 'payment_received' },
      ],
    };
  }
  return {
    nextState: ConversationState.AWAITING_PAYMENT_SCREENSHOT,
    context,
    actions: [],
  };
}

// Helper to keep TypeScript happy about referencing state values inside a switch.
function current(s: ConversationState): ConversationState {
  return s;
}
