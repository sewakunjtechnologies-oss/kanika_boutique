import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';

// Regression harness for the wrong-product false-positive auto-confirm:
// a non-EXACT match must route to a one-tap confirmation gate, never silently
// create an order. Only EXACT / AI-verified matches auto-confirm.
const h = vi.hoisted(() => {
  const conv = {
    id: 'conv1', customerId: 'cust1', state: 'IDLE', contextJson: {} as Record<string, unknown>,
    intent: 'UNKNOWN', humanTakeover: false, humanTakeoverUntil: null as Date | null,
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
      'IDLE', 'AWAITING_PRODUCT_CONFIRMATION', 'AWAITING_PRODUCT_MATCH_CONFIRMATION', 'AWAITING_NEW_PRODUCT',
      'AWAITING_SIZE', 'AWAITING_QTY', 'AWAITING_NAME', 'AWAITING_ADDRESS', 'AWAITING_PINCODE',
      'AWAITING_PAYMENT', 'AWAITING_PAYMENT_SCREENSHOT', 'AWAITING_VERIFICATION', 'COMPLETED', 'ABANDONED',
    ]),
    Intent: mkEnum(['ORDER_INTENT', 'PERSONAL_CHAT', 'UNKNOWN']),
    OrderStatus: mkEnum(['PENDING', 'PAYMENT_RECEIVED', 'PAYMENT_REVIEW', 'VERIFIED', 'PRINTED', 'DISPATCHED', 'CANCELLED', 'REJECTED', 'EXPIRED']),
    MessageType: mkEnum(['TEXT', 'IMAGE', 'INTERACTIVE_BUTTON', 'INTERACTIVE_LIST', 'TEMPLATE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'UNKNOWN']),
    MessageDirection: mkEnum(['INBOUND', 'OUTBOUND_BOT', 'OUTBOUND_OWNER_MANUAL']),
    Prisma: {
      Decimal: class { private v: unknown; constructor(v: unknown) { this.v = v; } toString() { return String(this.v); } },
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
vi.mock('../settings/businessSettings', () => ({ getBusinessSettings: vi.fn(async () => ({ upiId: 'shop@upi', shippingFee: 100 })) }));
vi.mock('../storage', () => ({ storage: { resolve: (p: string) => p, save: vi.fn(async () => 'p') } }));
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn(async () => Buffer.from('x')) }, readFile: vi.fn(async () => Buffer.from('x')) }));
vi.mock('./orderService', () => ({
  getProductAvailability: vi.fn(),
  checkStock: vi.fn(),
  suggestAlternatives: vi.fn(async () => []),
  createOrderFromContext: vi.fn(),
}));

import { prisma } from '@kda/db';
import { sendText, sendImage, sendInteractiveButtons } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { getProductAvailability, createOrderFromContext } from './orderService';
import { handleInboundMessage } from './orchestrator';

const imageInput = {
  conversationId: 'conv1', customerId: 'cust1', customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id: 'wamid.IMG1', timestamp: '1710000100', type: 'image' as const, image: { id: 'MID', mime_type: 'image/jpeg' } },
};
const buttonInput = (id: string, title = id) => ({
  conversationId: 'conv1', customerId: 'cust1', customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id: 'wamid.BTN', timestamp: '1710000200', type: 'interactive' as const, interactive: { type: 'button_reply' as const, button_reply: { id, title } } },
});

// A non-EXACT match (the soft-organza→mint-green mismatch): high score, but the
// scorer is saturated/non-discriminative, so it must NOT silently auto-confirm.
function nonExactMatch() {
  return {
    matchedProductId: 'wrong-mint', confidence: 0.92, confidenceBand: 'high',
    candidates: [{ productId: 'wrong-mint', sku: 'unstitched-suits-mqw7sgpe', name: 'Pure mul 4270', imageUrl: '/uploads/mint.jpg', confidence: 0.92 }],
    reasoning: 'garment_embedding_match', meetsThreshold: true, decision: 'auto_match',
    matchType: 'GARMENT_EMBEDDING_MATCH', autoConfirm: false, bestSecondMargin: 0.06,
  };
}
function exactMatch() {
  return {
    matchedProductId: 'p1', confidence: 1, confidenceBand: 'high',
    candidates: [{ productId: 'p1', sku: 'SKU1', name: 'Blue Suit', imageUrl: '/uploads/p1.jpg', confidence: 1 }],
    reasoning: 'exact_match', meetsThreshold: true, decision: 'auto_match',
    matchType: 'EXACT_MATCH', autoConfirm: true, bestSecondMargin: 1,
  };
}
function avail(id: string, sku: string, name: string) {
  return { id, sku, name, category: 'Stitched Suits', basePrice: '4270', imageUrl: `/uploads/${id}.jpg`, isActive: true,
    variants: [{ id: 'v40', size: '40', color: null, stock: 5, reserved: 0, physicalStock: 5 }] };
}

beforeEach(() => {
  h.conv.state = 'IDLE'; h.conv.contextJson = {}; h.conv.humanTakeover = false;
  vi.mocked(prisma.product.count).mockResolvedValue(1 as never);
  vi.mocked(sendText).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendImage).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendInteractiveButtons).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(matchProduct).mockReset();
  vi.mocked(getProductAvailability).mockReset();
  vi.mocked(createOrderFromContext).mockReset();
  env.IMAGE_MATCH_THRESHOLD = 0.5; env.GEMINI_API_KEY = '';
});
afterEach(() => vi.clearAllMocks());

describe('image-match confirmation gate (false-positive safety net)', () => {
  test('non-EXACT match does NOT auto-confirm — routes to confirmation gate, no order', async () => {
    vi.mocked(matchProduct).mockResolvedValue(nonExactMatch() as never);
    vi.mocked(getProductAvailability).mockResolvedValue(avail('wrong-mint', 'unstitched-suits-mqw7sgpe', 'Pure mul 4270') as never);

    await handleInboundMessage(imageInput as never);

    // Stays at the confirmation gate — NOT AWAITING_SIZE / AWAITING_NAME.
    expect(h.conv.state).toBe('AWAITING_PRODUCT_MATCH_CONFIRMATION');
    expect(h.conv.contextJson.candidateProductId).toBe('wrong-mint');
    expect(h.conv.contextJson.productId).toBeUndefined();
    // A YES/NO confirmation was sent (with the candidate image), no order created.
    expect(sendInteractiveButtons).toHaveBeenCalledTimes(1);
    const btn = vi.mocked(sendInteractiveButtons).mock.calls[0]!;
    expect(JSON.stringify(btn[3] ?? {})).toContain('mint.jpg'); // candidate image shown in header
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });

  test('EXACT (autoConfirm) match still auto-confirms straight to availability', async () => {
    vi.mocked(matchProduct).mockResolvedValue(exactMatch() as never);
    vi.mocked(getProductAvailability).mockResolvedValue(avail('p1', 'SKU1', 'Blue Suit') as never);

    await handleInboundMessage(imageInput as never);

    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(h.conv.contextJson.productId).toBe('p1');
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('confirmation gate YES → proceeds to the order flow for the confirmed product', async () => {
    vi.mocked(matchProduct).mockResolvedValue(nonExactMatch() as never);
    vi.mocked(getProductAvailability).mockResolvedValue(avail('wrong-mint', 'unstitched-suits-mqw7sgpe', 'Pure mul 4270') as never);
    await handleInboundMessage(imageInput as never);
    expect(h.conv.state).toBe('AWAITING_PRODUCT_MATCH_CONFIRMATION');

    await handleInboundMessage(buttonInput('product_confirm_yes', 'YES') as never);
    // Confirmed → product is now committed and the size step begins.
    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(h.conv.contextJson.productId).toBe('wrong-mint');
  });

  test('confirmation gate NO → rejects and asks for a new product (no order)', async () => {
    vi.mocked(matchProduct).mockResolvedValue(nonExactMatch() as never);
    vi.mocked(getProductAvailability).mockResolvedValue(avail('wrong-mint', 'unstitched-suits-mqw7sgpe', 'Pure mul 4270') as never);
    await handleInboundMessage(imageInput as never);

    await handleInboundMessage(buttonInput('product_confirm_no', 'NO') as never);
    expect(h.conv.state).toBe('AWAITING_NEW_PRODUCT');
    expect(createOrderFromContext).not.toHaveBeenCalled();
  });
});

// The Gemini verifier (Task 3) runs INSIDE matchProduct for non-near-duplicates and
// shapes the outcome. These tests assert the orchestrator honours that contract:
// a verified pick auto-confirms the CORRECT product; a "none" verdict stays silent.
describe('fresh-photo verifier outcomes (Task 3)', () => {
  // Verifier picked the correct product over the heuristic wrong one → autoConfirm.
  function verifierPickedCorrect() {
    return {
      matchedProductId: 'correct-organza', confidence: 0.78, confidenceBand: 'high',
      candidates: [
        { productId: 'correct-organza', sku: 'organza-1', name: 'Soft Organza', imageUrl: '/uploads/organza.jpg', confidence: 0.78 },
        { productId: 'wrong-blue', sku: 'pure-cottan-1', name: 'Pure Cottan', imageUrl: '/uploads/blue.jpg', confidence: 0.9 },
      ],
      reasoning: 'general_match:ai_selected', meetsThreshold: true, decision: 'auto_match',
      matchType: 'GENERAL_MATCH', autoConfirm: true, bestSecondMargin: 0.0,
    };
  }
  // Verifier said "none" → matchProduct returns NO MATCH.
  function verifierNone() {
    return {
      matchedProductId: null, confidence: 0.9, confidenceBand: 'low',
      candidates: [{ productId: 'wrong-blue', sku: 'pure-cottan-1', name: 'Pure Cottan', imageUrl: '/uploads/blue.jpg', confidence: 0.9 }],
      reasoning: 'no confident product match (ai_verifier_no_match)', meetsThreshold: false,
      decision: 'no_match', matchType: 'GENERAL_MATCH', autoConfirm: false, bestSecondMargin: 0.0,
    };
  }

  test('verifier picked the correct product → auto-confirms to THAT product, not the heuristic top', async () => {
    vi.mocked(matchProduct).mockResolvedValue(verifierPickedCorrect() as never);
    vi.mocked(getProductAvailability).mockResolvedValue(avail('correct-organza', 'organza-1', 'Soft Organza') as never);

    await handleInboundMessage(imageInput as never);

    expect(getProductAvailability).toHaveBeenCalledWith('correct-organza');
    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(h.conv.contextJson.productId).toBe('correct-organza');
    expect(sendInteractiveButtons).not.toHaveBeenCalled();
  });

  test('verifier returned "none" → NO MATCH, zero customer replies, no order (Task 2 silence)', async () => {
    vi.mocked(matchProduct).mockResolvedValue(verifierNone() as never);

    await handleInboundMessage(imageInput as never);

    const replies =
      vi.mocked(sendText).mock.calls.length +
      vi.mocked(sendImage).mock.calls.length +
      vi.mocked(sendInteractiveButtons).mock.calls.length;
    expect(replies).toBe(0);
    expect(createOrderFromContext).not.toHaveBeenCalled();
    expect(getProductAvailability).not.toHaveBeenCalled();
  });
});
