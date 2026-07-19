import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ConversationState } from '@kda/db';

// In-memory fake of the ioredis sorted set the flood counter uses. Because the
// counter's entire state lives here (in "Redis"), never in module memory, the
// "counter survives restart" property is testable: a fresh evaluate() call reads
// whatever entries a prior process left behind.
const store = new Map<string, Array<{ score: number; member: string }>>();
vi.mock('../queues/connection', () => ({
  redisConnection: {
    status: 'ready',
    zadd: vi.fn(async (key: string, score: number, member: string) => {
      const arr = store.get(key) ?? [];
      arr.push({ score, member });
      store.set(key, arr);
      return 1;
    }),
    zremrangebyscore: vi.fn(async (key: string, min: number, max: number) => {
      const kept = (store.get(key) ?? []).filter((e) => e.score < min || e.score > max);
      store.set(key, kept);
      return 0;
    }),
    zcard: vi.fn(async (key: string) => (store.get(key) ?? []).length),
    pexpire: vi.fn(async () => 1),
  },
}));

import {
  evaluateImageFloodForInbound,
  isImageFloodBreach,
  isInImageFloodCooldown,
  readImageFloodPausedUntil,
  recordImageAndCount,
} from './imageFloodGuard';

const KEY = 'kda:imgflood:';

const baseParams = (over: Partial<Parameters<typeof evaluateImageFloodForInbound>[0]> = {}) => ({
  conversationId: 'conv1',
  contextJson: {},
  state: ConversationState.IDLE,
  humanTakeover: false,
  humanTakeoverUntil: null,
  eventType: 'IMAGE',
  now: new Date('2026-07-19T10:00:00.000Z'),
  ...over,
});

beforeEach(() => store.clear());

describe('image flood — pure helpers', () => {
  test('breach only strictly above the allowance (max=5 lets 5 through, trips on 6)', () => {
    expect(isImageFloodBreach(5, 5)).toBe(false);
    expect(isImageFloodBreach(6, 5)).toBe(true);
    expect(isImageFloodBreach(2, 5)).toBe(false);
  });

  test('cooldown marker read + active check', () => {
    const now = new Date('2026-07-19T10:00:00.000Z');
    const future = new Date('2026-07-19T10:30:00.000Z').toISOString();
    const past = new Date('2026-07-19T09:00:00.000Z').toISOString();
    expect(readImageFloodPausedUntil({ imageFloodPausedUntil: future })?.toISOString()).toBe(future);
    expect(readImageFloodPausedUntil({})).toBeNull();
    expect(isInImageFloodCooldown({ imageFloodPausedUntil: future }, now)).toBe(true);
    expect(isInImageFloodCooldown({ imageFloodPausedUntil: past }, now)).toBe(false);
  });
});

describe('image flood — sliding-window Redis counter', () => {
  test('counts accumulate and prune outside the window', async () => {
    const windowMs = 120_000;
    const t0 = 1_000_000;
    expect(await recordImageAndCount('c', t0, windowMs)).toBe(1);
    expect(await recordImageAndCount('c', t0 + 1000, windowMs)).toBe(2);
    // A photo well past the window prunes the earlier two → count resets to 1.
    expect(await recordImageAndCount('c', t0 + windowMs + 5000, windowMs)).toBe(1);
  });
});

describe('image flood — evaluate decision', () => {
  test('6 rapid images breach on the 6th; the first 5 pass', async () => {
    const decisions: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      decisions.push(
        await evaluateImageFloodForInbound(
          baseParams({ now: new Date(Date.parse('2026-07-19T10:00:00.000Z') + i * 1000) }),
        ),
      );
    }
    expect(decisions).toEqual(['none', 'none', 'none', 'none', 'none', 'breach']);
  });

  test('a normal 2-photo customer is never affected', async () => {
    const d1 = await evaluateImageFloodForInbound(baseParams({ conversationId: 'calm' }));
    const d2 = await evaluateImageFloodForInbound(
      baseParams({ conversationId: 'calm', now: new Date('2026-07-19T10:00:05.000Z') }),
    );
    expect([d1, d2]).toEqual(['none', 'none']);
  });

  test('counter survives restart: pre-existing Redis entries still count toward the breach', async () => {
    // Simulate 5 photos recorded by a PRIOR process (persisted in Redis), then the
    // 6th arrives after a restart — it must breach using the persisted history.
    const now = Date.parse('2026-07-19T10:00:00.000Z');
    store.set(
      `${KEY}restart`,
      Array.from({ length: 5 }, (_, i) => ({ score: now - (i + 1) * 1000, member: `old-${i}` })),
    );
    const decision = await evaluateImageFloodForInbound(
      baseParams({ conversationId: 'restart', now: new Date(now) }),
    );
    expect(decision).toBe('breach');
  });

  test('during cooldown every inbound is silenced (text too), regardless of images', async () => {
    const now = new Date('2026-07-19T10:00:00.000Z');
    const ctx = { imageFloodPausedUntil: new Date('2026-07-19T10:30:00.000Z').toISOString() };
    expect(await evaluateImageFloodForInbound(baseParams({ contextJson: ctx, now, eventType: 'IMAGE' }))).toBe('silenced');
    expect(await evaluateImageFloodForInbound(baseParams({ contextJson: ctx, now, eventType: 'TEXT' }))).toBe('silenced');
  });

  test('does not count while an owner already has human takeover', async () => {
    const decision = await evaluateImageFloodForInbound(
      baseParams({ humanTakeover: true, humanTakeoverUntil: new Date('2026-07-19T16:00:00.000Z') }),
    );
    expect(decision).toBe('none');
  });

  test('payment-proof images are exempt from flood counting', async () => {
    for (let i = 0; i < 8; i += 1) {
      const d = await evaluateImageFloodForInbound(
        baseParams({
          conversationId: 'pay',
          state: ConversationState.AWAITING_PAYMENT_SCREENSHOT,
          now: new Date(Date.parse('2026-07-19T10:00:00.000Z') + i * 1000),
        }),
      );
      expect(d).toBe('none');
    }
  });
});
