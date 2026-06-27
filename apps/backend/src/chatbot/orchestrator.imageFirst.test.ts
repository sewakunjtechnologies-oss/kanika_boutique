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
import { sendText, sendImage, sendInteractiveButtons, sendInteractiveList, downloadMedia } from '../whatsapp/client';
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
  vi.mocked(matchProduct).mockReset();
  vi.mocked(getProductAvailability).mockReset();
  vi.mocked(createOrderFromContext).mockReset();
  vi.mocked(emitToDashboard).mockClear();
  // Production policy thresholds.
  env.IMAGE_AUTO_MATCH_THRESHOLD = 0.5;
  env.IMAGE_CANDIDATE_MATCH_THRESHOLD = 0.45;
  env.IMAGE_MIN_SCORE_MARGIN = 0.05;
  env.REPLY_ON_UNMATCHED_IMAGE = false;
  // Force deterministic intent classification (no live Gemini calls in tests).
  env.GEMINI_API_KEY = '';
});

afterEach(() => {
  env.GEMINI_API_KEY = originalGeminiKey;
  vi.clearAllMocks();
});

const noMatchOutcome = {
  matchedProductId: null,
  confidence: 0,
  confidenceBand: 'low',
  candidates: [],
  reasoning: 'no match',
  meetsThreshold: false,
  decision: 'no_match',
  bestSecondMargin: null,
};

const confidentOutcome = {
  matchedProductId: 'p1',
  confidence: 0.95,
  confidenceBand: 'high',
  candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl: '', confidence: 0.95 }],
  reasoning: 'strong match',
  meetsThreshold: true,
  decision: 'auto_match',
  bestSecondMargin: 1,
};

describe('image-first silent-match policy', () => {
  test('1: image never triggers an immediate "Let me check" acknowledgement', async () => {
    vi.mocked(matchProduct).mockResolvedValue(confidentOutcome as never);
    vi.mocked(getProductAvailability).mockResolvedValue({
      id: 'p1',
      name: 'Blue Suit',
      basePrice: '1500',
      isActive: true,
      variants: [{ size: '38', stock: 2, reserved: 0, physicalStock: 2 }],
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(allSentText().toLowerCase()).not.toContain('let me check');
    expect(allSentText().toLowerCase()).not.toContain('please wait while i check');
  });

  test('2 + 7: confident match → exactly one reply, after reading current stock', async () => {
    vi.mocked(matchProduct).mockResolvedValue(confidentOutcome as never);
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

    expect(getProductAvailability).toHaveBeenCalledWith('p1'); // checks current stock
    expect(customerReplyCount()).toBe(1); // exactly one customer-facing response
    const reply = allSentText();
    expect(reply.toLowerCase()).toContain('available');
    expect(reply).toContain('38');
    expect(reply).toContain('40');
    expect(reply).toContain('42');
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('3: unmatched image → zero responses, no order, dashboard signalled', async () => {
    vi.mocked(matchProduct).mockResolvedValue(noMatchOutcome as never);

    await expect(handleInboundMessage(imageInput as never)).resolves.toBeUndefined();

    expect(downloadMedia).toHaveBeenCalled(); // image WAS processed
    expect(customerReplyCount()).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
    expect(emitToDashboard).toHaveBeenCalledWith('image_unmatched', expect.objectContaining({ conversationId: 'conv1' }));
  });

  test('4a: low-confidence candidate → zero responses, no order', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: 'p1',
      confidence: 0.46,
      confidenceBand: 'medium',
      candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Suit', imageUrl: 'https://cdn.test/suit.jpg', confidence: 0.46 }],
      reasoning: 'weak match',
      meetsThreshold: false,
      decision: 'candidate_confirmation',
      bestSecondMargin: 1,
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(0);
    expect(sendImage).not.toHaveBeenCalled();
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('4b: ambiguous high score with tiny margin → zero responses', async () => {
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
      decision: 'candidate_confirmation',
      bestSecondMargin: 0.02,
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(customerReplyCount()).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('confident match but zero stock still replies (out of stock)', async () => {
    vi.mocked(matchProduct).mockResolvedValue(confidentOutcome as never);
    vi.mocked(getProductAvailability).mockResolvedValue({
      id: 'p1',
      name: 'Blue Suit',
      basePrice: '1500',
      isActive: true,
      variants: [{ size: '38', stock: 0, reserved: 0, physicalStock: 0 }],
    } as never);

    await handleInboundMessage(imageInput as never);

    expect(allSentText().toLowerCase()).toContain('out of stock');
  });

  test('inventory index empty → no download and zero responses', async () => {
    vi.mocked(prisma.product.count).mockResolvedValue(0 as never);
    vi.mocked(matchProduct).mockResolvedValue(noMatchOutcome as never);

    await handleInboundMessage(imageInput as never);

    expect(downloadMedia).not.toHaveBeenCalled();
    expect(customerReplyCount()).toBe(0);
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
