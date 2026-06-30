import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Shared, inspectable mock state (hoisted so vi.mock factories can use it).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const conv = {
    id: 'conv1',
    customerId: 'cust1',
    state: 'IDLE',
    contextJson: {},
    intent: 'UNKNOWN',
    humanTakeover: false,
    humanTakeoverUntil: null as Date | null,
  };
  const mkEnum = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, k]));
  return { conv, mkEnum };
});

vi.mock('@kda/db', () => {
  const { conv, mkEnum } = h;
  return {
    prisma: {
      conversation: {
        findUnique: vi.fn(async () => conv),
        // Mutate the shared conv so flow-version checks see persisted state.
        update: vi.fn(async ({ data }: { data: { state?: string; contextJson?: unknown } }) => {
          if (data.state) conv.state = data.state;
          if ('contextJson' in data) conv.contextJson = (data.contextJson ?? {}) as Record<string, unknown>;
          return conv;
        }),
        findFirst: vi.fn(async () => null),
        findMany: vi.fn(async () => []),
      },
      message: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
      order: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
      product: { findMany: vi.fn(async () => []), count: vi.fn(async () => 1) },
      customer: { upsert: vi.fn(async () => ({ id: 'cust1' })) },
      dashboardNotification: { create: vi.fn(async () => ({ id: 'n1' })) },
    },
    ConversationState: mkEnum([
      'IDLE',
      'AWAITING_PRODUCT_CONFIRMATION',
      'AWAITING_PRODUCT_MATCH_CONFIRMATION',
      'AWAITING_NEW_PRODUCT',
      'AWAITING_SIZE',
      'AWAITING_QTY',
      'AWAITING_NAME',
      'AWAITING_ADDRESS',
      'AWAITING_PINCODE',
      'AWAITING_PAYMENT',
      'AWAITING_PAYMENT_SCREENSHOT',
      'AWAITING_VERIFICATION',
      'COMPLETED',
      'ABANDONED',
    ]),
    Intent: mkEnum(['ORDER_INTENT', 'PERSONAL_CHAT', 'UNKNOWN']),
    OrderStatus: mkEnum([
      'PENDING',
      'PAYMENT_RECEIVED',
      'PAYMENT_REVIEW',
      'VERIFIED',
      'PRINTED',
      'DISPATCHED',
      'CANCELLED',
      'REJECTED',
      'EXPIRED',
    ]),
    MessageType: mkEnum(['TEXT', 'IMAGE', 'INTERACTIVE_BUTTON', 'INTERACTIVE_LIST', 'TEMPLATE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'UNKNOWN']),
    MessageDirection: mkEnum(['INBOUND', 'OUTBOUND_BOT', 'OUTBOUND_OWNER_MANUAL']),
    Prisma: {
      Decimal: class {
        private v: unknown;
        constructor(v: unknown) {
          this.v = v;
        }
        toString() {
          return String(this.v);
        }
      },
      PrismaClientKnownRequestError: class extends Error {},
    },
  };
});

vi.mock('../whatsapp/client', () => ({
  sendText: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  sendImage: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  sendInteractiveButtons: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  sendInteractiveList: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  downloadMedia: vi.fn(async () => ({ storedPath: 'whatsapp-media/MID.jpg', mimeType: 'image/jpeg' })),
  downloadMediaToBuffer: vi.fn(async () => ({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' })),
}));

vi.mock('../ai/productMatcher', () => ({ matchProduct: vi.fn() }));
vi.mock('../ai/paymentExtractor', () => ({ extractPayment: vi.fn() }));
vi.mock('../realtime/io', () => ({ emitToDashboard: vi.fn() }));
vi.mock('../settings/businessSettings', () => ({
  getBusinessSettings: vi.fn(async () => ({ upiId: 'shop@upi', shippingFee: 0 })),
}));
vi.mock('../storage', () => ({ storage: { resolve: (p: string) => p, save: vi.fn(async () => 'p') } }));
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => Buffer.from('fake-image')) },
  readFile: vi.fn(async () => Buffer.from('fake-image')),
}));
vi.mock('./orderService', () => ({
  getProductAvailability: vi.fn(),
  checkStock: vi.fn(),
  suggestAlternatives: vi.fn(async () => []),
  createOrderFromContext: vi.fn(),
}));

import { prisma } from '@kda/db';
import { sendText, sendImage, sendInteractiveButtons, sendInteractiveList, downloadMedia, downloadMediaToBuffer } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { extractPayment } from '../ai/paymentExtractor';
import * as intentClassifier from '../ai/intentClassifier';
import { getProductAvailability, createOrderFromContext, checkStock } from './orderService';
import { emitToDashboard } from '../realtime/io';
import { logger } from '../logger';
import { handleInboundMessage } from './orchestrator';

const imageInput = {
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: {
    from: '919999999999',
    id: 'wamid.IMG1',
    timestamp: '1710000100',
    type: 'image' as const,
    image: { id: 'MID', mime_type: 'image/jpeg' },
  },
};

const textInput = (body: string) => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: {
    from: '919999999999',
    id: 'wamid.TXT1',
    timestamp: '1710000100',
    type: 'text' as const,
    text: { body },
  },
});

const buttonInput = (id: string, title = id) => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: {
    from: '919999999999',
    id: 'wamid.BTN1',
    timestamp: '1710000200',
    type: 'interactive' as const,
    interactive: { type: 'button_reply' as const, button_reply: { id, title } },
  },
});

const listInput = (id: string, title = id) => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: {
    from: '919999999999',
    id: 'wamid.LIST1',
    timestamp: '1710000200',
    type: 'interactive' as const,
    interactive: { type: 'list_reply' as const, list_reply: { id, title } },
  },
});

const originalGeminiKey = env.GEMINI_API_KEY;

/** Count of every customer-facing outbound send across all channels. */
function customerReplyCount(): number {
  return (
    vi.mocked(sendText).mock.calls.length +
    vi.mocked(sendImage).mock.calls.length +
    vi.mocked(sendInteractiveButtons).mock.calls.length +
    vi.mocked(sendInteractiveList).mock.calls.length
  );
}

/** Every string argument the bot tried to send to the customer. */
function allSentText(): string {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => String(c[1])),
    ...vi.mocked(sendImage).mock.calls.map((c) => String(c[2] ?? '')),
    ...vi.mocked(sendInteractiveButtons).mock.calls.map((c) => String(c[1])),
    ...vi.mocked(sendInteractiveList).mock.calls.map((c) => String(c[1])),
  ].join('\n');
}

beforeEach(() => {
  h.conv.state = 'IDLE';
  h.conv.contextJson = {};
  h.conv.humanTakeover = false;
  vi.mocked(prisma.product.count).mockResolvedValue(1 as never);
  vi.mocked(prisma.product.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.order.findUnique).mockResolvedValue(null as never);
  vi.mocked(prisma.order.findFirst).mockResolvedValue(null as never);
  vi.mocked(prisma.order.update).mockResolvedValue({} as never);
  vi.mocked(prisma.dashboardNotification.create).mockClear().mockResolvedValue({ id: 'n1' } as never);
  vi.mocked(sendText).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendImage).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendInteractiveButtons).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendInteractiveList).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(downloadMedia).mockClear().mockResolvedValue({ storedPath: 'whatsapp-media/MID.jpg', mimeType: 'image/jpeg' });
  vi.mocked(downloadMediaToBuffer).mockClear().mockResolvedValue({ buffer: Buffer.from('img'), mimeType: 'image/jpeg' });
  vi.mocked(matchProduct).mockReset();
  vi.mocked(getProductAvailability).mockReset();
  vi.mocked(createOrderFromContext).mockReset();
  vi.mocked(emitToDashboard).mockClear();
  // Single confirm-first threshold.
  env.IMAGE_AUTO_MATCH_THRESHOLD = 0.5;
  env.IMAGE_CANDIDATE_MATCH_THRESHOLD = 0.5;
  env.IMAGE_MIN_SCORE_MARGIN = 0.08;
  env.REPLY_ON_UNMATCHED_IMAGE = false;
  // Force deterministic intent classification (no live Gemini calls in tests).
  env.GEMINI_API_KEY = '';
});

afterEach(() => {
  env.GEMINI_API_KEY = originalGeminiKey;
  vi.clearAllMocks();
});

function outcome(score: number, imageUrl = 'https://cdn.test/p1.jpg') {
  return {
    matchedProductId: score >= 0.5 ? 'p1' : null,
    confidence: score,
    confidenceBand: 'high',
    candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl, confidence: score }],
    reasoning: 'match',
    meetsThreshold: score >= 0.5,
    decision: score >= 0.5 ? 'auto_match' : 'no_match',
    matchType: score >= 0.5 ? 'EXACT_MATCH' : null,
    // These flow tests assume an auto-confirmed (EXACT/verified) match so they can
    // exercise the downstream availability → size → name path. Non-EXACT gating is
    // covered separately in the confirmation-gate regression tests.
    autoConfirm: score >= 0.5,
    bestSecondMargin: 1,
  };
}

const noMatchOutcome = outcome(0, '');

function availability(sizes: Array<{ size: string; stock: number }>) {
  return {
    id: 'p1',
    sku: 'SKU1',
    name: 'Blue Suit',
    basePrice: '1760',
    imageUrl: '/uploads/p1.jpg',
    isActive: true,
    variants: sizes.map((s) => ({ ...s, reserved: 0, physicalStock: s.stock })),
  };
}

// Customer-facing copy intentionally omits internal product name + article/SKU.
const EXACT_AVAILABILITY_CAPTION =
  'Yes, it is available.\nPrice: ₹1760\nAvailable sizes: 40\n\nPlease send your size.';

describe('direct image availability matching', () => {
  test('8: score below 0.50 → zero responses, no order', async () => {
    vi.mocked(matchProduct).mockResolvedValue(outcome(0.49) as never);

    await handleInboundMessage(imageInput as never);

    expect(downloadMediaToBuffer).toHaveBeenCalled();
    expect(customerReplyCount()).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('image no-match (no candidate, e.g. chat screenshot / random photo) → ZERO customer replies, dashboard alert only', async () => {
    // No candidate at all — not a near-miss, an entirely unmatched image.
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: null,
      confidence: 0,
      confidenceBand: 'low',
      candidates: [],
      reasoning: 'no usable catalog match',
      meetsThreshold: false,
      decision: 'no_match',
      matchType: null,
      autoConfirm: false,
      bestSecondMargin: null,
    } as never);

    await handleInboundMessage(imageInput as never);

    // Customer gets NOTHING — no fallback, menu, "press start" or catalog/FAQ.
    expect(customerReplyCount()).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
    // Team visibility: a dashboard alert flagged as needing a human reply.
    expect(emitToDashboard).toHaveBeenCalledWith(
      'image_unmatched',
      expect.objectContaining({ conversationId: 'conv1', needsHumanReply: true }),
    );
  });

  test('9 + 10 + 13: score >= 0.50 → exactly one availability image, no confirmation/lists/stock', async () => {
    vi.mocked(matchProduct).mockResolvedValue(outcome(0.5) as never);
    vi.mocked(getProductAvailability).mockResolvedValue(availability([{ size: '40', stock: 2 }]) as never);

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(1);
    expect(sendImage).toHaveBeenCalledWith('919999999999', { link: expect.stringContaining('/uploads/p1.jpg') }, EXACT_AVAILABILITY_CAPTION);
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
    expect(sendInteractiveList).not.toHaveBeenCalled();
    // Customer copy no longer leaks internal name/article.
    expect(allSentText()).not.toContain('Article: SKU1');
    expect(allSentText()).not.toContain('Blue Suit');
    expect(allSentText()).toContain('Price: ₹1760');
    expect(allSentText()).toContain('Available sizes: 40');
    expect(allSentText()).toContain('Please send your size.');
    expect(allSentText()).not.toMatch(/pcs|stock|possible match|available products|confirm product/i);
    expect(createOrderFromContext).not.toHaveBeenCalled();
    expect(h.conv.state).toBe('AWAITING_SIZE');
  });

  test('matched photo → bot asks size → customer sends 42 → bot asks name', async () => {
    vi.mocked(matchProduct).mockResolvedValue(outcome(0.5) as never);
    vi.mocked(getProductAvailability).mockResolvedValue(availability([{ size: '42', stock: 2 }]) as never);
    const classifierSpy = vi.spyOn(intentClassifier, 'classifyCustomerIntent');

    await handleInboundMessage(imageInput as never);

    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(allSentText()).toContain('Available sizes: 42');
    expect(allSentText()).toContain('Please send your size.');
    vi.mocked(sendText).mockClear();
    vi.mocked(sendImage).mockClear();
    vi.mocked(sendInteractiveButtons).mockClear();
    vi.mocked(sendInteractiveList).mockClear();

    await handleInboundMessage(textInput('42') as never);

    expect(classifierSpy).not.toHaveBeenCalled();
    expect(getProductAvailability).toHaveBeenLastCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(h.conv.contextJson).toMatchObject({ productId: 'p1', selectedProductId: 'p1', size: '42', selectedSize: '42', qty: 1 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('919999999999', 'What name should we put on the order?');
    expect(customerReplyCount()).toBe(1);
  });

  test('8b: unmatched image emits dashboard signal but sends nothing', async () => {
    vi.mocked(matchProduct).mockResolvedValue(noMatchOutcome as never);

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(0);
    expect(emitToDashboard).toHaveBeenCalledWith('image_unmatched', expect.objectContaining({ conversationId: 'conv1' }));
  });

  test('12: download failure → zero responses', async () => {
    vi.mocked(downloadMediaToBuffer).mockRejectedValueOnce(new Error('non_image_content_type'));

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(0);
  });

  test('1 + 2: a new photo hard-resets old in-progress order state', async () => {
    h.conv.state = 'AWAITING_NAME';
    h.conv.contextJson = {
      productId: 'old_product',
      candidateProductId: 'old_candidate',
      size: '40',
      qty: 1,
      customerName: 'Old Name',
      address: 'Old address',
      city: 'OldCity',
      pincode: '111111',
      activeFlowVersion: 3,
    } as never;
    vi.mocked(matchProduct).mockResolvedValue(noMatchOutcome as never);

    await handleInboundMessage(imageInput as never);

    // Old product/order fields are gone and the flow version was bumped.
    const ctx = h.conv.contextJson as Record<string, unknown>;
    expect(ctx.productId).toBeUndefined();
    expect(ctx.candidateProductId).toBeUndefined();
    expect(ctx.size).toBeUndefined();
    expect(ctx.customerName).toBeUndefined();
    expect(ctx.activeFlowVersion).toBe(4);
  });

  test('3: a slow old match result is discarded when a newer photo arrived', async () => {
    vi.mocked(getProductAvailability).mockResolvedValue(availability([{ size: '40', stock: 2 }]) as never);
    // Simulate a newer flow starting WHILE this match runs.
    vi.mocked(matchProduct).mockImplementation(async () => {
      (h.conv.contextJson as Record<string, unknown>).activeFlowVersion = 999;
      return outcome(0.9) as never;
    });

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(0); // stale → send nothing
  });

  test('empty inventory → no download and zero responses', async () => {
    vi.mocked(prisma.product.count).mockResolvedValue(0 as never);
    vi.mocked(matchProduct).mockResolvedValue(noMatchOutcome as never);

    await handleInboundMessage(imageInput as never);

    expect(downloadMediaToBuffer).not.toHaveBeenCalled();
    expect(customerReplyCount()).toBe(0);
  });
});

describe('YES product confirmation → availability by variant stock', () => {
  function confirmCtx(extra: Record<string, unknown> = {}) {
    h.conv.state = 'AWAITING_PRODUCT_MATCH_CONFIRMATION';
    h.conv.contextJson = {
      candidateProductId: 'p1',
      candidateProductName: 'Three-Piece Kurti',
      candidateCreatedAt: new Date('2999-01-01T00:00:00.000Z').toISOString(),
      activeFlowVersion: 1,
      activeMediaId: 'm1',
      ...extra,
    } as never;
  }
  function prod(variants: Array<{ size: string; stock: number }>) {
    return {
      id: 'p1',
      sku: 'ABC-123',
      name: 'Three-Piece Kurti',
      basePrice: '1760',
      imageUrl: '/uploads/p1.jpg',
      isActive: true,
      variants: variants.map((v) => ({ ...v, id: `v_${v.size}`, color: null, reserved: 0, physicalStock: v.stock })),
    };
  }

  test('1 + 4 + 8 + 10: YES with one in-stock variant → loads candidate, available, AWAITING_SIZE, no size needed', async () => {
    confirmCtx();
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '40', stock: 3 }]) as never);

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);

    expect(getProductAvailability).toHaveBeenCalledWith('p1'); // correct candidate loaded
    expect(allSentText()).toContain('Available');
    // Customer copy no longer leaks internal name/article (kept on order + label only).
    expect(allSentText()).not.toContain('Article: ABC-123');
    expect(allSentText()).not.toContain('Three-Piece Kurti');
    expect(h.conv.state).toBe('AWAITING_SIZE');
  });

  test('2: YES with several in-stock variants → available, sizes sorted numerically', async () => {
    confirmCtx();
    vi.mocked(getProductAvailability).mockResolvedValue(
      prod([{ size: '44', stock: 1 }, { size: '38', stock: 2 }, { size: '42', stock: 1 }, { size: '40', stock: 5 }]) as never,
    );

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);

    expect(allSentText()).toContain('Available sizes: 38, 40, 42, 44');
  });

  test('5: YES with all variants zero stock → "This product is currently unavailable."', async () => {
    confirmCtx();
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '40', stock: 0 }, { size: '42', stock: 0 }]) as never);

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);

    expect(allSentText()).toContain('This product is currently unavailable.');
    expect(allSentText()).not.toContain('This is not available.');
  });

  test('7: available response shows NO stock counts', async () => {
    confirmCtx();
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '40', stock: 3 }, { size: '42', stock: 9 }]) as never);

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);

    expect(allSentText()).not.toMatch(/\b\d+\s*pc|stock|: 3|: 9/i);
  });

  test('button value is normalized (PRODUCT_CONFIRM_YES still confirms)', async () => {
    confirmCtx();
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '40', stock: 3 }]) as never);

    await handleInboundMessage(buttonInput('PRODUCT_CONFIRM_YES', 'YES') as never);

    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(allSentText()).toContain('Available');
  });

  test('9: a stale YES after a newer photo reset does not start the old order', async () => {
    // A newer photo hard-reset the flow: state back to confirmation-pending, candidate gone.
    h.conv.state = 'AWAITING_PRODUCT_CONFIRMATION';
    h.conv.contextJson = { activeFlowVersion: 2, activeMediaId: 'm2' } as never;

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);

    expect(getProductAvailability).not.toHaveBeenCalled();
    expect(h.conv.state).not.toBe('AWAITING_SIZE');
  });

  test('NO clears the candidate and hands off to the team (Case 2 escalation)', async () => {
    confirmCtx();

    await handleInboundMessage(buttonInput('product_confirm_no', 'NO') as never);

    // Brief human hand-off line — no re-guess, no order, candidate cleared.
    expect(allSentText()).toContain('Our team will help you with this shortly.');
    expect(h.conv.state).toBe('AWAITING_NEW_PRODUCT');
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('11: size-specific stock is checked only after the customer chooses a size', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['40', '42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '40', stock: 2 }, { size: '42', stock: 0 }]) as never);

    // Choosing the in-stock size advances to name.
    await handleInboundMessage(buttonInput('size_40', '40') as never);
    expect(getProductAvailability).toHaveBeenCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(allSentText().toLowerCase()).toContain('name');
  });

  test('AWAITING_SIZE + "42" is routed to size selection before catalog intent', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = {
      productId: 'p1',
      selectedProductId: 'p1',
      productName: 'Three-Piece Kurti',
      availableSizes: ['42'],
      activeFlowId: 'flow1',
      activeFlowVersion: 7,
      availableProductOptions: ['stale-option-1'],
      availableProductListShown: true,
      availableProductListSize: '42',
    } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '42', stock: 3 }]) as never);
    const classifierSpy = vi.spyOn(intentClassifier, 'classifyCustomerIntent');

    await handleInboundMessage(textInput('42') as never);

    expect(classifierSpy).not.toHaveBeenCalled();
    expect(getProductAvailability).toHaveBeenCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(h.conv.contextJson).toMatchObject({ size: '42', selectedSize: '42', qty: 1 });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith('919999999999', 'What name should we put on the order?');
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
    expect(sendInteractiveList).not.toHaveBeenCalled();
    expect(allSentText()).not.toMatch(/how many|quantity|pcs|stock|product numbers/i);
  });

  test('AWAITING_SIZE + button size_42 asks for name', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', selectedProductId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '42', stock: 3 }]) as never);

    await handleInboundMessage(buttonInput('size_42', '42') as never);

    expect(getProductAvailability).toHaveBeenCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(h.conv.contextJson).toMatchObject({ productId: 'p1', selectedProductId: 'p1', size: '42', selectedSize: '42', qty: 1 });
    expect(sendText).toHaveBeenCalledWith('919999999999', 'What name should we put on the order?');
  });

  test('AWAITING_SIZE + list size_42 asks for name', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', selectedProductId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '42', stock: 3 }]) as never);

    await handleInboundMessage(listInput('size_42', '42') as never);

    expect(getProductAvailability).toHaveBeenCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(h.conv.contextJson).toMatchObject({ productId: 'p1', selectedProductId: 'p1', size: '42', selectedSize: '42', qty: 1 });
    expect(sendText).toHaveBeenCalledWith('919999999999', 'What name should we put on the order?');
  });

  test('invalid size keeps product selected and sends exact unavailable-size message only', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['38', '40', '42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '38', stock: 1 }, { size: '40', stock: 2 }, { size: '42', stock: 1 }]) as never);

    await handleInboundMessage(textInput('44') as never);

    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect((h.conv.contextJson as Record<string, unknown>).productId).toBe('p1');
    expect(sendText).toHaveBeenCalledWith(
      '919999999999',
      'That size is not available.\n\nAvailable sizes: 38, 40, 42\n\nPlease send one available size.',
    );
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
    expect(sendInteractiveList).not.toHaveBeenCalled();
    expect(allSentText()).not.toMatch(/how many|quantity|pcs|stock/i);
  });

  test('AWAITING_SIZE + cancel cancels the flow', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', selectedProductId: 'p1', availableSizes: ['42'], qty: 1 } as never;

    await handleInboundMessage(textInput('cancel') as never);

    expect(getProductAvailability).not.toHaveBeenCalled();
    expect(h.conv.state).toBe('IDLE');
    expect(allSentText().toLowerCase()).toContain('cancelled');
  });

  test('AWAITING_SIZE + change product requests a new product photo', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', selectedProductId: 'p1', availableSizes: ['42'], qty: 1 } as never;

    await handleInboundMessage(textInput('change product') as never);

    expect(getProductAvailability).not.toHaveBeenCalled();
    expect(h.conv.state).toBe('AWAITING_NEW_PRODUCT');
    expect(allSentText()).toContain('Please send the new product photo or article number');
  });

  test('AWAITING_SIZE + selectedProductId only uses compatibility fallback', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { selectedProductId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '42', stock: 3 }]) as never);

    await handleInboundMessage(textInput('42') as never);

    expect(getProductAvailability).toHaveBeenCalledWith('p1');
    expect(h.conv.state).toBe('AWAITING_NAME');
    expect(h.conv.contextJson).toMatchObject({ productId: 'p1', selectedProductId: 'p1', size: '42', selectedSize: '42', qty: 1 });
  });

  test('AWAITING_SIZE + missing product IDs logs and recovers instead of silently dropping', async () => {
    const loggerInfoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined as never);
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { availableSizes: ['42'], activeFlowId: 'flow1' } as never;

    try {
      await handleInboundMessage(textInput('42') as never);

      expect(getProductAvailability).not.toHaveBeenCalled();
      expect(h.conv.state).toBe('AWAITING_NEW_PRODUCT');
      expect(sendText).toHaveBeenCalledWith(
        '919999999999',
        "Please send the product photo or article number first, then I'll check availability.",
      );
      expect(loggerInfoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'SIZE_SELECTION_CONTEXT_MISSING',
          conversationId: 'conv1',
          state: 'AWAITING_SIZE',
          hasProductId: false,
          hasSelectedProductId: false,
          activeFlowId: 'flow1',
        }),
        'SIZE_SELECTION_CONTEXT_MISSING',
      );
    } finally {
      loggerInfoSpy.mockRestore();
    }
  });

  test('duplicate "42" after moving to AWAITING_NAME does not re-run size selection', async () => {
    h.conv.state = 'AWAITING_SIZE';
    h.conv.contextJson = { productId: 'p1', selectedProductId: 'p1', productName: 'Three-Piece Kurti', availableSizes: ['42'], qty: 1 } as never;
    vi.mocked(getProductAvailability).mockResolvedValue(prod([{ size: '42', stock: 3 }]) as never);

    await handleInboundMessage(textInput('42') as never);
    vi.mocked(sendText).mockClear();
    await handleInboundMessage(textInput('42') as never);

    expect(getProductAvailability).toHaveBeenCalledTimes(1);
    expect(h.conv.state).toBe('AWAITING_ADDRESS');
    expect(h.conv.contextJson).toMatchObject({ size: '42', selectedSize: '42', customerName: '42' });
    expect(sendText).toHaveBeenCalledWith(
      '919999999999',
      'Please send your complete delivery address with house/flat, street/area, city, state and 6-digit pincode in one message.',
    );
  });
});

describe('order creation + QR payment', () => {
  test('AWAITING_NAME + text asks for full address', async () => {
    h.conv.state = 'AWAITING_NAME';
    h.conv.contextJson = {
      productId: 'p1',
      selectedProductId: 'p1',
      productName: 'Blue Suit',
      size: '42',
      selectedSize: '42',
      qty: 1,
      productPrice: 1760,
      unitPrice: 1760,
    } as never;

    await handleInboundMessage(textInput('Madhav') as never);

    expect(h.conv.state).toBe('AWAITING_ADDRESS');
    expect(h.conv.contextJson).toMatchObject({ customerName: 'Madhav', size: '42', selectedSize: '42' });
    expect(sendText).toHaveBeenCalledWith(
      '919999999999',
      'Please send your complete delivery address with house/flat, street/area, city, state and 6-digit pincode in one message.',
    );
  });

  test('15 + 19 + 20 + 21: address reply → order qty 1, QR image with amount, no UPI ID', async () => {
    env.PAYMENT_QR_IMAGE_URL = 'https://cdn.test/qr.png';
    h.conv.state = 'AWAITING_ADDRESS';
    h.conv.contextJson = {
      productId: 'p1',
      productName: 'Blue Suit',
      size: '40',
      qty: 1,
      productPrice: 1760,
      availableSizes: ['40'],
    } as never;
    vi.mocked(checkStock).mockResolvedValue({ available: true, stock: 5, reserved: 0, physicalStock: 5 } as never);
    vi.mocked(createOrderFromContext).mockResolvedValue({ orderId: 'o1', orderNumber: 'ORD-2026-0001', total: 1860 } as never);

    await handleInboundMessage(textInput('H-12, Sector 5, Jaipur, Rajasthan 302021') as never);

    expect(createOrderFromContext).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ qty: 1 }) }),
    );
    expect(sendImage).toHaveBeenCalledWith(
      '919999999999',
      { link: 'https://cdn.test/qr.png' },
      'Order #ORD-2026-0001\nAmount to pay: ₹1860\n\nPlease send the payment screenshot once paid.',
    );
    expect(allSentText().toLowerCase()).not.toContain('upi');
  });

  test('payment screenshot attaches proof, notifies dashboard, and sends no customer acknowledgement', async () => {
    h.conv.state = 'AWAITING_PAYMENT_SCREENSHOT';
    h.conv.contextJson = { orderId: 'o1', orderNumber: 'ORD-2026-0001', total: 1860 } as never;
    vi.mocked(downloadMedia).mockResolvedValue({ storedPath: 'payments/pay1.jpg', mimeType: 'image/jpeg' });
    vi.mocked(extractPayment).mockResolvedValue({
      amount: 1860,
      utr: 'UTR123',
      receiverUpi: 'shop@upi',
      receiverName: null,
      looksLegitimate: true,
      reasoning: 'ok',
    } as never);
    const pendingOrder = {
      id: 'o1',
      customerId: 'cust1',
      orderNumber: 'ORD-2026-0001',
      status: 'PENDING',
      totalAmount: { toString: () => '1860' },
      shippingName: 'Madhav',
      adminNotifiedAt: null,
    };
    vi.mocked(prisma.order.findUnique).mockResolvedValue(pendingOrder as never);
    vi.mocked(prisma.order.findFirst)
      .mockResolvedValueOnce(pendingOrder as never)
      .mockResolvedValueOnce(null as never);

    await handleInboundMessage({
      ...imageInput,
      receiverPhoneNumberId: 'business_phone_1',
      message: {
        ...imageInput.message,
        id: 'wamid.PAY1',
        image: { id: 'PAY_MEDIA', mime_type: 'image/jpeg' },
      },
    } as never);

    expect(matchProduct).not.toHaveBeenCalled();
    expect(prisma.order.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'o1' },
      data: expect.objectContaining({
        paymentScreenshotUrl: 'payments/pay1.jpg',
        paymentScreenshotMediaId: 'PAY_MEDIA',
        paymentCustomerWaId: '919999999999',
        paymentReceiverPhoneId: 'business_phone_1',
      }),
    }));
    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalledWith('919999999999', expect.any(String));
    expect(sendImage).not.toHaveBeenCalledWith('919999999999', expect.anything(), expect.anything());
  });
});

describe('text + casual flows', () => {
  test('E: "Is this available?" without product context → asks for photo', async () => {
    await handleInboundMessage(textInput('Is this available?') as never);

    const reply = allSentText().toLowerCase();
    expect(reply).toContain('send the product photo');
  });

  test('5: greeting "hi" without shopping intent → zero responses', async () => {
    await handleInboundMessage(textInput('hi') as never);
    expect(customerReplyCount()).toBe(0);
  });
});
