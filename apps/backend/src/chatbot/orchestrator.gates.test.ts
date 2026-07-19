import { beforeEach, describe, expect, test, vi } from 'vitest';

// End-to-end wiring test for the three inbound pre-gates (mute, image flood, link
// nudge) added to handleInboundMessage. Mirrors the orchestrator.imageFirst.test
// harness. The flood counter's Redis is faked in-memory so a breach is deterministic.

const h = vi.hoisted(() => {
  const conv = {
    id: 'conv1',
    customerId: 'cust1',
    state: 'IDLE',
    contextJson: {} as Record<string, unknown>,
    intent: 'UNKNOWN',
    humanTakeover: false,
    humanTakeoverUntil: null as Date | null,
    botMuted: false,
  };
  const mkEnum = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, k]));
  const zstore = new Map<string, Array<{ score: number; member: string }>>();
  return { conv, mkEnum, zstore };
});

vi.mock('../queues/connection', () => ({
  redisConnection: {
    status: 'ready',
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const arr = h.zstore.get(key) ?? [];
      arr.push({ score, member });
      h.zstore.set(key, arr);
      return 1;
    }),
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      h.zstore.set(key, (h.zstore.get(key) ?? []).filter((e) => e.score < min || e.score > max));
      return 0;
    }),
    zcard: vi.fn(async (key: string) => (h.zstore.get(key) ?? []).length),
    pexpire: vi.fn(async () => 1),
  },
}));

vi.mock('@kda/db', () => {
  const { conv, mkEnum } = h;
  return {
    prisma: {
      conversation: {
        findUnique: vi.fn(async () => conv),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (data.state) conv.state = data.state as string;
          if ('contextJson' in data) conv.contextJson = (data.contextJson ?? {}) as Record<string, unknown>;
          if ('humanTakeover' in data) conv.humanTakeover = data.humanTakeover as boolean;
          if ('humanTakeoverUntil' in data) conv.humanTakeoverUntil = data.humanTakeoverUntil as Date | null;
          if ('botMuted' in data) conv.botMuted = data.botMuted as boolean;
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
vi.mock('../settings/businessSettings', () => ({ getBusinessSettings: vi.fn(async () => ({ upiId: 'shop@upi', shippingFee: 0 })) }));
vi.mock('../storage', () => ({ storage: { resolve: (p: string) => p, save: vi.fn(async () => 'p') } }));
vi.mock('node:fs/promises', () => ({ default: { readFile: vi.fn(async () => Buffer.from('x')) }, readFile: vi.fn(async () => Buffer.from('x')) }));
vi.mock('./orderService', () => ({
  getProductAvailability: vi.fn(),
  checkStock: vi.fn(),
  suggestAlternatives: vi.fn(async () => []),
  createOrderFromContext: vi.fn(),
}));

import { prisma } from '@kda/db';
import { sendText } from '../whatsapp/client';
import { matchProduct } from '../ai/productMatcher';
import { handleInboundMessage } from './orchestrator';
import { IMAGE_FLOOD_NOTICE } from './imageFloodGuard';
import { LINK_NUDGE_MESSAGE } from './linkNudge';

const imageInput = () => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id: 'wamid.IMG', timestamp: '1710000100', type: 'image' as const, image: { id: 'MID', mime_type: 'image/jpeg' } },
});
const textInput = (body: string) => ({
  conversationId: 'conv1',
  customerId: 'cust1',
  customerWhatsappNumber: '919999999999',
  message: { from: '919999999999', id: 'wamid.TXT', timestamp: '1710000100', type: 'text' as const, text: { body } },
});

const floodFlagCount = () =>
  vi.mocked(prisma.dashboardNotification.create).mock.calls.filter(
    (c) => (c[0] as { data: { type: string } }).data.type === 'IMAGE_FLOOD',
  ).length;

beforeEach(() => {
  h.conv.state = 'IDLE';
  h.conv.contextJson = {};
  h.conv.humanTakeover = false;
  h.conv.humanTakeoverUntil = null;
  h.conv.botMuted = false;
  h.zstore.clear();
  vi.clearAllMocks();
});

describe('TASK 2 — mute gate', () => {
  test('a muted conversation does zero processing on an inbound image', async () => {
    h.conv.botMuted = true;
    await handleInboundMessage(imageInput());
    expect(vi.mocked(sendText)).not.toHaveBeenCalled();
    expect(vi.mocked(matchProduct)).not.toHaveBeenCalled();
    expect(vi.mocked(prisma.dashboardNotification.create)).not.toHaveBeenCalled();
  });

  test('unmuting restores normal processing (image reaches matching)', async () => {
    h.conv.botMuted = false;
    await handleInboundMessage(imageInput());
    expect(vi.mocked(matchProduct)).toHaveBeenCalledTimes(1);
  });
});

describe('TASK 1 — image flood breach', () => {
  test('crossing the window sends exactly one notice + one flag, then silences', async () => {
    // Pre-seed 5 recent photos in Redis (as if from before), so the next image is the 6th.
    const now = Date.now();
    h.zstore.set('kda:imgflood:conv1', Array.from({ length: 5 }, (_, i) => ({ score: now - (i + 1) * 100, member: `p${i}` })));

    await handleInboundMessage(imageInput()); // 6th → breach

    expect(vi.mocked(sendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendText).mock.calls[0]?.[1]).toBe(IMAGE_FLOOD_NOTICE);
    expect(floodFlagCount()).toBe(1);
    expect(vi.mocked(matchProduct)).not.toHaveBeenCalled(); // breach returns before matching
    expect(h.conv.humanTakeover).toBe(true);

    // A subsequent image during cooldown is fully silenced — no further notice/flag.
    await handleInboundMessage(imageInput());
    expect(vi.mocked(sendText)).toHaveBeenCalledTimes(1);
    expect(floodFlagCount()).toBe(1);
  });
});

describe('TASK 3 — link nudge', () => {
  test('a link-only message nudges once; a second link does not repeat', async () => {
    await handleInboundMessage(textInput('https://instagram.com/p/abc'));
    expect(vi.mocked(sendText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendText).mock.calls[0]?.[1]).toBe(LINK_NUDGE_MESSAGE);
    expect(h.conv.contextJson.linkNudgeSent).toBe(true);
    expect(vi.mocked(matchProduct)).not.toHaveBeenCalled();

    await handleInboundMessage(textInput('https://instagram.com/reel/def'));
    expect(vi.mocked(sendText)).toHaveBeenCalledTimes(1); // no duplicate nudge
  });

  test('an image after the nudge flows to normal matching', async () => {
    h.conv.contextJson = { linkNudgeSent: true };
    await handleInboundMessage(imageInput());
    expect(vi.mocked(matchProduct)).toHaveBeenCalledTimes(1);
  });
});
