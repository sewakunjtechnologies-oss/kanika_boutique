// Image flood guard — protects the bot from bulk/manufacturer senders who blast
// many photos at once (no fixed number list; purely rate-based per conversation).
//
// A sliding-window counter lives in Redis (a per-conversation sorted set keyed by
// timestamp), so it survives restarts and is shared across workers. When more than
// IMAGE_FLOOD_MAX product photos arrive within IMAGE_FLOOD_WINDOW_MINUTES the bot:
//   1. auto-pauses processing for that conversation (human takeover),
//   2. sends EXACTLY ONE notice ("send one photo at a time"),
//   3. emits ONE dashboard flag (reason IMAGE_FLOOD),
//   4. then stays fully silent until IMAGE_FLOOD_COOLDOWN_MINUTES elapses or the
//      owner clears takeover (resume-bot wipes the flood marker in contextJson).
//
// Normal 2-3 photo customers never breach the window and are unaffected. The pure
// helpers (breach test, cooldown read) are unit-tested in isolation; the Redis
// counter is exercised against an in-memory fake. Nothing here throws in a way that
// breaks the inbound flow — the caller treats an error as "no flood".

import { randomUUID } from 'node:crypto';
import { ConversationState, prisma } from '@kda/db';
import { redisConnection } from '../queues/connection';
import { env } from '../config/env';
import { botError, botLog } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { sendText } from '../whatsapp/client';
import { maskCustomerNumber } from './escalation';
import { readOrderContext } from './orderContextGuard';

/** The single, calm notice sent to a flooding sender (sent at most once per breach). */
export const IMAGE_FLOOD_NOTICE =
  "Please send one product photo at a time and I'll check availability.";

/** Payment-proof images are never counted as product-photo floods. */
const PAYMENT_STATES = new Set<ConversationState>([
  ConversationState.AWAITING_PAYMENT,
  ConversationState.AWAITING_PAYMENT_SCREENSHOT,
  ConversationState.AWAITING_VERIFICATION,
]);

export type ImageFloodDecision = 'silenced' | 'breach' | 'none';

function floodKey(conversationId: string): string {
  return `kda:imgflood:${conversationId}`;
}

/**
 * Only touch Redis when the shared connection is actually ready. ioredis keeps an
 * offline command queue, so issuing a command while disconnected would hang rather
 * than reject — we must not block a real customer's photo on a Redis outage, so the
 * flood guard fails OPEN (no counting) whenever Redis is not ready.
 */
function isRedisReady(): boolean {
  return (redisConnection as unknown as { status?: string }).status === 'ready';
}

/**
 * A breach is strictly MORE than the allowance within the window, so a shop with
 * IMAGE_FLOOD_MAX=5 lets a customer send up to 5 photos and only trips on the 6th.
 */
export function isImageFloodBreach(countInWindow: number, max: number): boolean {
  return countInWindow > max;
}

/** ISO flood-pause marker → Date, or null when absent/invalid. */
export function readImageFloodPausedUntil(contextJson: unknown): Date | null {
  const raw = readOrderContext(contextJson).imageFloodPausedUntil;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** True while a prior breach's cooldown is still in effect (→ full silence). */
export function isInImageFloodCooldown(contextJson: unknown, now: Date): boolean {
  const until = readImageFloodPausedUntil(contextJson);
  return until !== null && until.getTime() > now.getTime();
}

function isActiveHumanTakeover(humanTakeover: boolean, until: Date | null, now: Date): boolean {
  return humanTakeover && (until === null || until.getTime() > now.getTime());
}

/**
 * Record one inbound product photo and return how many fall inside the sliding
 * window. State lives entirely in Redis (no process memory), so the count is
 * correct across restarts and across concurrent workers.
 */
export async function recordImageAndCount(
  conversationId: string,
  nowMs: number,
  windowMs: number,
): Promise<number> {
  const key = floodKey(conversationId);
  const member = `${nowMs}:${randomUUID()}`;
  await redisConnection.zadd(key, nowMs, member);
  // Drop everything older than the window so the count is a true sliding window.
  await redisConnection.zremrangebyscore(key, 0, nowMs - windowMs);
  const count = await redisConnection.zcard(key);
  // Let the key self-expire once the window passes with no new photos.
  await redisConnection.pexpire(key, windowMs);
  return count;
}

/**
 * Decide what the flood guard should do for one inbound message. Pure control flow
 * around the single Redis counter call:
 *   - 'silenced' — a prior breach's cooldown is active → drop this message silently
 *     (any type, not just images).
 *   - 'breach'   — this image just crossed the threshold → caller pauses + notifies.
 *   - 'none'     — carry on with normal processing.
 */
export async function evaluateImageFloodForInbound(params: {
  conversationId: string;
  contextJson: unknown;
  state: ConversationState;
  humanTakeover: boolean;
  humanTakeoverUntil: Date | null;
  eventType: string;
  now: Date;
}): Promise<ImageFloodDecision> {
  // Our own cooldown wins first: while it is active the conversation is fully muted.
  if (isInImageFloodCooldown(params.contextJson, params.now)) return 'silenced';
  // An owner/agent already handling this thread is not the flood guard's business.
  if (isActiveHumanTakeover(params.humanTakeover, params.humanTakeoverUntil, params.now)) return 'none';
  // Only genuine product photos are counted (payment screenshots are exempt).
  if (params.eventType !== 'IMAGE') return 'none';
  if (PAYMENT_STATES.has(params.state)) return 'none';
  // Fail open when Redis is unavailable — never hang or block a real photo.
  if (!isRedisReady()) return 'none';

  try {
    const windowMs = env.IMAGE_FLOOD_WINDOW_MINUTES * 60_000;
    const count = await recordImageAndCount(params.conversationId, params.now.getTime(), windowMs);
    return isImageFloodBreach(count, env.IMAGE_FLOOD_MAX) ? 'breach' : 'none';
  } catch (err) {
    // If Redis is unavailable, fail open — never block a real customer's photo.
    botError('ERROR_DETAILS', err, { step: 'image_flood_count' });
    return 'none';
  }
}

/**
 * Handle a confirmed breach: pause the bot for the cooldown, send the single notice,
 * and raise one dashboard flag. Idempotent in practice because the persisted
 * cooldown marker makes every subsequent inbound resolve to 'silenced' before this
 * runs again — so exactly one notice and one flag are produced per breach.
 */
export async function handleImageFloodBreach(params: {
  conversationId: string;
  customerWhatsappNumber: string;
  contextJson: unknown;
  now: Date;
}): Promise<void> {
  const cooldownUntil = new Date(params.now.getTime() + env.IMAGE_FLOOD_COOLDOWN_MINUTES * 60_000);
  const masked = maskCustomerNumber(params.customerWhatsappNumber);

  // 1. Persist the pause: human takeover (dashboard-visible) + the flood marker that
  //    silences everything until cooldown. Owner "resume-bot" clears both.
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      humanTakeover: true,
      humanTakeoverUntil: cooldownUntil,
      contextJson: {
        ...readOrderContext(params.contextJson),
        imageFloodPausedUntil: cooldownUntil.toISOString(),
      } as never,
    },
  });

  // 2. Exactly one calm notice. ignoreTakeover because we just set takeover above.
  try {
    await sendText(params.customerWhatsappNumber, IMAGE_FLOOD_NOTICE, { ignoreTakeover: true });
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'image_flood_notice' });
  }

  // 3. Exactly one dashboard flag (durable notification + live socket ping).
  try {
    await prisma.dashboardNotification.create({
      data: {
        type: 'IMAGE_FLOOD',
        title: 'Image flood auto-paused',
        body: `Customer ${masked} sent too many photos too fast. Bot paused for ${env.IMAGE_FLOOD_COOLDOWN_MINUTES} min.`,
        entityType: 'conversation',
        entityId: params.conversationId,
        metadata: { reason: 'IMAGE_FLOOD', customerMasked: masked } as never,
      },
    });
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'image_flood_flag' });
  }
  emitToDashboard('escalation_created', {
    conversationId: params.conversationId,
    customerMasked: masked,
    reason: 'IMAGE_FLOOD',
  });
  emitToDashboard('takeover_changed', {
    conversationId: params.conversationId,
    humanTakeover: true,
    reason: 'IMAGE_FLOOD',
  });

  botLog('IMAGE_FLOOD_PAUSED', {
    conversationId: params.conversationId,
    customerMasked: masked,
    cooldownMinutes: env.IMAGE_FLOOD_COOLDOWN_MINUTES,
  });
}
