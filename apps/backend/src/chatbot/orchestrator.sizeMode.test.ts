import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';

// ---------------------------------------------------------------------------
// Mock harness (mirrors orchestrator.imageFirst.test.ts) focused on size mode:
// proves an unstitched product NEVER enters AWAITING_SIZE while a stitched one does.
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const conv = {
    id: 'conv1',
    customerId: 'cust1',
    state: 'IDLE',
    contextJson: {} as Record<string, unknown>,
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
import { sendText, sendImage } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { getProductAvailability, checkStock, createOrderFromContext } from './orderService';
import { handleInboundMessage } from './orchestrator';

const imageInput = {
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id: 'wamid.IMG1', timestamp: '1710000100', type: 'image' as const, image: { id: 'MID', mime_type: 'image/jpeg' } },
};

const textInput = (body: string, id: string) => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id, timestamp: '1710000200', type: 'text' as const, text: { body } },
});

function matchOutcome() {
  return {
    matchedProductId: 'p1', confidence: 0.92, confidenceBand: 'high',
    candidates: [{ productId: 'p1', sku: 'UN-201', name: 'Pure Muslin Unstitched Suit', imageUrl: '/uploads/p1.jpg', confidence: 0.92 }],
    reasoning: 'match', meetsThreshold: true, decision: 'auto_match', bestSecondMargin: 1, matchType: 'EXACT_MATCH',
  };
}

function availability(category: string, variants: Array<{ id: string; size: string; stock: number }>) {
  return {
    id: 'p1', sku: 'UN-201', name: 'Pure Muslin Unstitched Suit', category, basePrice: '2765',
    imageUrl: '/uploads/p1.jpg', isActive: true,
    variants: variants.map((v) => ({ ...v, color: null, reserved: 0, physicalStock: v.stock })),
  };
}

function sentText(): string {
  return [
    ...vi.mocked(sendText).mock.calls.map((c) => String(c[1])),
    ...vi.mocked(sendImage).mock.calls.map((c) => String(c[2] ?? '')),
  ].join('\n');
}

beforeEach(() => {
  h.conv.state = 'IDLE';
  h.conv.contextJson = {};
  h.conv.humanTakeover = false;
  vi.mocked(prisma.product.count).mockResolvedValue(1 as never);
  vi.mocked(sendText).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(sendImage).mockClear().mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(matchProduct).mockReset().mockResolvedValue(matchOutcome() as never);
  vi.mocked(getProductAvailability).mockReset();
  env.IMAGE_MATCH_THRESHOLD = 0.5;
  env.GEMINI_API_KEY = '';
});

afterEach(() => vi.clearAllMocks());

describe('unstitched product flow — never asks for size', () => {
  test.each([
    ['three legacy numeric size rows', [{ id: 'a', size: '38', stock: 2 }, { id: 'b', size: '40', stock: 5 }, { id: 'c', size: '42', stock: 1 }]],
    ['a single Free Size variant', [{ id: 'fs', size: 'Free Size', stock: 3 }]],
    ['one legacy numeric row', [{ id: 'a', size: '40', stock: 4 }]],
  ])('unstitched with %s → goes straight to AWAITING_NAME with FREE_SIZE', async (_label, variants) => {
    vi.mocked(getProductAvailability).mockResolvedValue(availability('Unstitched Suits', variants as never) as never);

    await handleInboundMessage(imageInput as never);

    expect(h.conv.state).toBe('AWAITING_NAME');
    const ctx = h.conv.contextJson;
    expect(ctx.selectedSize).toBe('FREE_SIZE');
    expect(ctx.sizeMode).toBe('FREE_SIZE');
    expect(ctx.qty).toBe(1);
    expect(ctx.variantId).toBeTruthy();
    expect(ctx.availableSizes).toEqual([]);

    const text = sentText();
    expect(text).toContain('Size: Free Size');
    expect(text).toContain('What name should we put on the order?');
    // ZERO size prompts.
    expect(text).not.toMatch(/Please send your size/i);
    expect(text).not.toMatch(/Available sizes/i);
    expect(text).not.toMatch(/what size/i);
  });

  test('unstitched with zero stock is unavailable (not a size prompt)', async () => {
    vi.mocked(getProductAvailability).mockResolvedValue(availability('Unstitched Suits', [{ id: 'a', size: '40', stock: 0 }]) as never);
    await handleInboundMessage(imageInput as never);
    expect(h.conv.state).toBe('IDLE');
    expect(sentText()).toMatch(/unavailable/i);
  });
});

describe('unstitched end-to-end — name → address → order', () => {
  test('completes with backing variant, qty 1, FREE_SIZE; ₹100 delivery applied', async () => {
    vi.mocked(getProductAvailability).mockResolvedValue(
      availability('Unstitched Suits', [{ id: 'b', size: '40', stock: 5 }]) as never,
    );
    vi.mocked(checkStock).mockResolvedValue({ available: true, stock: 5, physicalStock: 5, reserved: 0, variantId: 'b' } as never);
    vi.mocked(createOrderFromContext).mockResolvedValue({ orderId: 'ord1', orderNumber: 'ORD-2026-0001', total: 2865 } as never);

    await handleInboundMessage(imageInput as never);
    expect(h.conv.state).toBe('AWAITING_NAME');

    await handleInboundMessage(textInput('Asha Verma', 'wamid.NAME') as never);
    expect(h.conv.state).toBe('AWAITING_ADDRESS');

    await handleInboundMessage(textInput('H.No 5, Sector 2, Sonipat, Haryana 131001', 'wamid.ADDR') as never);

    expect(createOrderFromContext).toHaveBeenCalledTimes(1);
    const arg = vi.mocked(createOrderFromContext).mock.calls[0]![0];
    expect(arg.ctx.qty).toBe(1);
    // Order attaches to the real backing variant size, while display stays FREE_SIZE.
    expect(arg.ctx.size).toBe('40');
    expect(arg.ctx.selectedSize).toBe('FREE_SIZE');
    expect(arg.ctx.customerName).toBe('Asha Verma');
    expect(arg.ctx.pincode).toBe('131001');
  });
});

describe('stitched product flow — asks for size', () => {
  test('stitched product lists sizes and enters AWAITING_SIZE', async () => {
    vi.mocked(getProductAvailability).mockResolvedValue(
      availability('Stitched Suits', [{ id: 'a', size: '38', stock: 2 }, { id: 'b', size: '40', stock: 5 }]) as never,
    );

    await handleInboundMessage(imageInput as never);

    expect(h.conv.state).toBe('AWAITING_SIZE');
    expect(h.conv.contextJson.sizeMode).toBe('SIZED');
    const text = sentText();
    expect(text).toMatch(/Available sizes/i);
    expect(text).toMatch(/Please send your size/i);
    expect(text).not.toContain('Size: Free Size');
  });
});
