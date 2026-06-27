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
        update: vi.fn(async () => conv),
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
  sendInteractiveButtons: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  sendInteractiveList: vi.fn(async () => ({ ok: true, wamid: 'w', conversationId: 'conv1' })),
  downloadMedia: vi.fn(async () => ({ storedPath: 'whatsapp-media/MID.jpg', mimeType: 'image/jpeg' })),
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
import { sendText, sendInteractiveButtons, sendInteractiveList, downloadMedia } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { getProductAvailability, createOrderFromContext } from './orderService';
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

function anyCustomerReplySent(): boolean {
  return (
    vi.mocked(sendText).mock.calls.length > 0 ||
    vi.mocked(sendInteractiveButtons).mock.calls.length > 0 ||
    vi.mocked(sendInteractiveList).mock.calls.length > 0
  );
}

beforeEach(() => {
  h.conv.state = 'IDLE';
  h.conv.contextJson = {};
  h.conv.humanTakeover = false;
  vi.mocked(prisma.product.count).mockResolvedValue(1 as never);
  vi.mocked(prisma.product.findMany).mockResolvedValue([] as never);
  vi.mocked(prisma.message.findFirst).mockResolvedValue(null as never);
  vi.mocked(sendText).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendInteractiveButtons).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendInteractiveList).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(downloadMedia).mockClear().mockResolvedValue({ storedPath: 'whatsapp-media/MID.jpg', mimeType: 'image/jpeg' });
  vi.mocked(matchProduct).mockReset();
  vi.mocked(getProductAvailability).mockReset();
  vi.mocked(createOrderFromContext).mockReset();
  vi.mocked(emitToDashboard).mockClear();
  env.IMAGE_MATCH_MIN_CONFIDENCE = 0.9;
  env.REPLY_ON_UNMATCHED_IMAGE = false;
  // Force deterministic intent classification (no live Gemini calls in tests).
  env.GEMINI_API_KEY = '';
});

afterEach(() => {
  env.GEMINI_API_KEY = originalGeminiKey;
  vi.clearAllMocks();
});

const lowOutcome = {
  matchedProductId: null,
  confidence: 0,
  confidenceBand: 'low',
  candidates: [],
  reasoning: 'no match',
  meetsThreshold: false,
  bestSecondMargin: null,
};

describe('image-first availability flow', () => {
  test('A: no inventory match → webhook 200, clearer-photo reply, no order', async () => {
    vi.mocked(matchProduct).mockResolvedValue(lowOutcome as never);

    await expect(handleInboundMessage(imageInput as never)).resolves.toBeUndefined();

    expect(downloadMedia).toHaveBeenCalled(); // image WAS processed
    expect(sendText).toHaveBeenCalledWith('919999999999', 'Let me check this product for you.');
    expect(vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n')).toContain("couldn't confidently match");
    expect(createOrderFromContext).not.toHaveBeenCalled();
    expect(emitToDashboard).toHaveBeenCalledWith('image_unmatched', expect.objectContaining({ conversationId: 'conv1' }));
  });

  test('B: match below threshold → fallback reply, no order created', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: 'p1',
      confidence: 0.6,
      confidenceBand: 'medium',
      candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Suit', imageUrl: '', confidence: 0.6 }],
      reasoning: 'weak match',
      meetsThreshold: false,
      bestSecondMargin: 1,
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n')).toContain("couldn't confidently match");
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('B2: visually similar ambiguous candidates → fallback reply, no order created', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: 'p1',
      confidence: 0.95,
      confidenceBand: 'high',
      candidates: [
        { productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl: '', confidence: 0.95 },
        { productId: 'p2', sku: 'SKU2', name: 'Similar Blue Suit', imageUrl: '', confidence: 0.93 },
      ],
      reasoning: 'ambiguous match',
      meetsThreshold: true,
      bestSecondMargin: 0.02,
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n')).toContain("couldn't confidently match");
    expect(sendInteractiveList).toHaveBeenCalledWith(
      '919999999999',
      expect.stringContaining('closest catalog photos'),
      'View matches',
      expect.any(Array),
    );
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('C: confident match + stock available → availability reply with sizes', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: 'p1',
      confidence: 0.95,
      confidenceBand: 'high',
      candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl: '', confidence: 0.95 }],
      reasoning: 'strong match',
      meetsThreshold: true,
      bestSecondMargin: 1,
    } as never);
    vi.mocked(getProductAvailability).mockResolvedValue({
      id: 'p1',
      name: 'Blue Suit',
      basePrice: '1500',
      isActive: true,
      variants: [
        { size: '38', stock: 2, reserved: 0, physicalStock: 2 },
        { size: '40', stock: 1, reserved: 0, physicalStock: 1 },
        { size: '42', stock: 3, reserved: 0, physicalStock: 3 },
      ],
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(anyCustomerReplySent()).toBe(true);
    const reply = [
      ...vi.mocked(sendText).mock.calls.map((c) => c[1]),
      ...vi.mocked(sendInteractiveButtons).mock.calls.map((c) => c[1]),
    ].join('\n');
    expect(reply.toLowerCase()).toContain('available');
    expect(reply).toContain('38');
    expect(reply).toContain('40');
    expect(reply).toContain('42');
  });

  test('D: confident match but zero stock → out-of-stock reply', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: 'p1',
      confidence: 0.95,
      confidenceBand: 'high',
      candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl: '', confidence: 0.95 }],
      reasoning: 'strong match',
      meetsThreshold: true,
      bestSecondMargin: 1,
    } as never);
    vi.mocked(getProductAvailability).mockResolvedValue({
      id: 'p1',
      name: 'Blue Suit',
      basePrice: '1500',
      isActive: true,
      variants: [{ size: '38', stock: 0, reserved: 0, physicalStock: 0 }],
    } as never);

    await handleInboundMessage(imageInput as never);

    const reply = vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n').toLowerCase();
    expect(reply).toContain('out of stock');
  });

  test('A2 (inventory guard): empty image index → no download, customer fallback', async () => {
    vi.mocked(prisma.product.count).mockResolvedValue(0 as never);

    await handleInboundMessage(imageInput as never);

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n')).toContain("couldn't confidently match");
  });
});

describe('text + casual flows', () => {
  test('E: "Is this available?" without product context → asks for photo', async () => {
    await handleInboundMessage(textInput('Is this available?') as never);

    const reply = vi.mocked(sendText).mock.calls.map((c) => c[1]).join('\n').toLowerCase();
    expect(reply).toContain('send the product photo');
  });

  test('F: casual "hi" → no bot reply', async () => {
    await handleInboundMessage(textInput('hi') as never);
    expect(anyCustomerReplySent()).toBe(false);
  });
});
