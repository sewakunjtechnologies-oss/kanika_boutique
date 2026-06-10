import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
      },
      message: {
        findFirst: vi.fn(async () => null),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async () => ({})),
        createMany: vi.fn(async () => ({ count: 0 })),
      },
      order: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
      product: { findMany: vi.fn(async () => []) },
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
    MessageType: mkEnum([
      'TEXT',
      'IMAGE',
      'INTERACTIVE_BUTTON',
      'INTERACTIVE_LIST',
      'TEMPLATE',
      'AUDIO',
      'VIDEO',
      'DOCUMENT',
      'LOCATION',
      'UNKNOWN',
    ]),
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

import { prisma } from '@kda/db';
import { sendText, downloadMedia } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { handleInboundMessage } from './orchestrator';
import { CHECKING_PRODUCT_MESSAGE } from './stateMachine';
import { UNMATCHED_IMAGE_REPLY } from './pausedResume';

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

beforeEach(() => {
  h.conv.state = 'IDLE';
  h.conv.contextJson = {};
  h.conv.humanTakeover = false;
  vi.mocked(sendText).mockClear();
  vi.mocked(sendText).mockResolvedValue({ ok: true, wamid: 'w', conversationId: 'conv1' });
  vi.mocked(downloadMedia).mockClear();
  vi.mocked(downloadMedia).mockResolvedValue({ storedPath: 'whatsapp-media/MID.jpg', mimeType: 'image/jpeg' });
  vi.mocked(matchProduct).mockReset();
});

afterEach(() => vi.clearAllMocks());

describe('image-first product availability flow', () => {
  test('A: image message replies "Let me check this product for you." before matching', async () => {
    vi.mocked(matchProduct).mockResolvedValue({
      matchedProductId: null,
      confidence: 0,
      confidenceBand: 'low',
      candidates: [],
      reasoning: 'no match',
    } as never);

    await handleInboundMessage(imageInput as never);

    // The ack is the very first thing sent to the customer.
    expect(sendText).toHaveBeenCalled();
    expect(vi.mocked(sendText).mock.calls[0]![1]).toBe(CHECKING_PRODUCT_MESSAGE);
    // And the ack is sent before media download begins.
    const ackOrder = vi.mocked(sendText).mock.invocationCallOrder[0]!;
    const downloadOrder = vi.mocked(downloadMedia).mock.invocationCallOrder[0]!;
    expect(ackOrder).toBeLessThan(downloadOrder);
  });

  test('E: media download failure does not throw (webhook stays 200) and falls back gracefully', async () => {
    vi.mocked(downloadMedia).mockRejectedValue(new Error('graph media 404'));

    // handleInboundMessage must resolve — the webhook already returned 200 and
    // a thrown error here would only surface as an unhandled BullMQ failure.
    await expect(handleInboundMessage(imageInput as never)).resolves.toBeUndefined();

    const bodies = vi.mocked(sendText).mock.calls.map((c) => c[1]);
    expect(bodies[0]).toBe(CHECKING_PRODUCT_MESSAGE);
    expect(bodies).toContain(UNMATCHED_IMAGE_REPLY);
  });
});
