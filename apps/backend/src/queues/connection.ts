import IORedis, { type Redis } from 'ioredis';
import { env } from '../config/env';

// Shared connection for app-side Redis ops (not BullMQ — BullMQ uses its own
// nested ioredis via connection options to avoid version-conflict types).
export const redisConnection: Redis = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

// Plain connection options for BullMQ Queue + Worker — avoids the
// dual-ioredis type collision when passing an actual Redis instance.
const parsed = new URL(env.REDIS_URL);
export const bullConnection = {
  host: parsed.hostname,
  port: parsed.port ? Number(parsed.port) : 6379,
  password: parsed.password || undefined,
  username: parsed.username || undefined,
  db: parsed.pathname && parsed.pathname.length > 1 ? Number(parsed.pathname.slice(1)) : 0,
  // Managed Redis (Render Key Value, Upstash, etc.) is served over TLS via the
  // rediss:// scheme. Without this, BullMQ connects in plaintext and the handshake
  // fails. Building from the URL by hand drops the scheme, so re-add TLS here.
  ...(parsed.protocol === 'rediss:' ? { tls: { servername: parsed.hostname } } : {}),
};
