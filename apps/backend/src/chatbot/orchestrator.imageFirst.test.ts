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
      order: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
      product: { findMany: vi.fn(async () => []), count: vi.fn(async () => 1) },
      customer: { upsert: vi.fn(async () => ({ id: 'cust1' })) },
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
import { getProductAvailability, createOrderFromContext, checkStock } from './orderService';
import { emitToDashboard } from '../realtime/io';
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
    decision: score >= 0.5 ? 'candidate_confirmation' : 'no_match',
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

describe('confirm-first image matching', () => {
  test('8: score below 0.50 → zero responses, no order', async () => {
    vi.mocked(matchProduct).mockResolvedValue(outcome(0.49) as never);

    await handleInboundMessage(imageInput as never);

    expect(downloadMediaToBuffer).toHaveBeenCalled();
    expect(customerReplyCount()).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('9 + 10 + 13: score >= 0.50 → exactly one candidate image + YES/NO, no lists/stock', async () => {
    vi.mocked(matchProduct).mockResolvedValue(outcome(0.5) as never);
    vi.mocked(getProductAvailability).mockResolvedValue(availability([{ size: '40', stock: 2 }]) as never);

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(1);
    // One interactive button message: minimal body + YES/NO + image header.
    expect(sendInteractiveButtons).toHaveBeenCalledWith(
      '919999999999',
      'Confirm product',
      [
        { id: 'product_confirm_yes', title: 'YES' },
        { id: 'product_confirm_no', title: 'NO' },
      ],
      expect.objectContaining({ headerImageUrl: expect.stringContaining('p1.jpg') }),
    );
    // No alternative product list, no stock counts, no extra description.
    expect(sendInteractiveList).not.toHaveBeenCalled();
    expect(allSentText()).not.toMatch(/pcs|stock|possible match|available products/i);
    expect(createOrderFromContext).not.toHaveBeenCalled();
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

describe('order creation + QR payment', () => {
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
    vi.mocked(createOrderFromContext).mockResolvedValue({ orderId: 'o1', orderNumber: 'ORD-1', total: 1860 } as never);

    await handleInboundMessage(textInput('H-12, Sector 5, Jaipur, Rajasthan 302021') as never);

    expect(createOrderFromContext).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: expect.objectContaining({ qty: 1 }) }),
    );
    expect(sendImage).toHaveBeenCalledWith(
      '919999999999',
      { link: 'https://cdn.test/qr.png' },
      expect.stringContaining('Amount to pay: ₹1860'),
    );
    expect(allSentText().toLowerCase()).not.toContain('upi');
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
