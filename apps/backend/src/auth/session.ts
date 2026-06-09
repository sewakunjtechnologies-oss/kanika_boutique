import session, { type SessionData } from 'express-session';
import type { CookieOptions as ExpressCookieOptions, NextFunction, Request, Response } from 'express';
import type { AdminRole } from '@kda/db';
import { prisma } from '@kda/db';
import { env } from '../config/env';
import { logger } from '../logger';
import { redisConnection } from '../queues/connection';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = env.SESSION_COOKIE_MAX_AGE_DAYS * MS_PER_DAY;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
const REDIS_PREFIX = 'kda:sess:';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    email?: string;
    role?: AdminRole;
    createdAt?: string;
    expiresAt?: string;
  }
}

export const DASHBOARD_SESSION_COOKIE_NAME = env.SESSION_COOKIE_NAME;

export function createDashboardSessionMiddleware(): ReturnType<typeof session> {
  return session({
    name: DASHBOARD_SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    store: new HybridSessionStore(),
    resave: false,
    saveUninitialized: false,
    rolling: false,
    proxy: env.NODE_ENV === 'production',
    cookie: getSessionCookieOptions(),
  });
}

export function getSessionCookieOptions(): session.CookieOptions {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE,
    domain: env.SESSION_COOKIE_DOMAIN,
    path: '/',
    maxAge: SESSION_TTL_MS,
  };
}

export function ensurePersistentSessionCookieHeader(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() === 'set-cookie') {
      return originalSetHeader(name, addSessionCookieMaxAge(value));
    }
    return originalSetHeader(name, value);
  };
  next();
}

export function addSessionCookieMaxAge(value: number | string | readonly string[]): number | string | readonly string[] {
  if (typeof value === 'string') return addMaxAgeToCookie(value);
  if (Array.isArray(value)) return value.map(addMaxAgeToCookie);
  return value;
}

export function getClearSessionCookieOptions(): ExpressCookieOptions {
  return {
    httpOnly: true,
    secure: env.SESSION_COOKIE_SECURE,
    sameSite: env.SESSION_COOKIE_SAMESITE,
    domain: env.SESSION_COOKIE_DOMAIN,
    path: '/',
  };
}

export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

export function saveSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

export function destroySession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!req.session) {
      resolve();
      return;
    }
    req.session.destroy((err) => (err ? reject(err) : resolve()));
  });
}

class HybridSessionStore extends session.Store {
  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    void this.getSession(sid)
      .then((stored) => callback(null, stored))
      .catch((err) => {
        logger.warn({ err, hasSid: Boolean(sid) }, 'session get failed');
        callback(err);
      });
  }

  set(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    void this.setSession(sid, sess)
      .then(() => callback?.())
      .catch((err) => {
        logger.warn({ err, hasSid: Boolean(sid) }, 'session set failed');
        callback?.(err);
      });
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    void Promise.allSettled([
      redisConnection.del(redisKey(sid)),
      prisma.adminSession.delete({ where: { id: sid } }).catch((err: unknown) => {
        if (isPrismaNotFound(err)) return null;
        throw err;
      }),
    ])
      .then((results) => {
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) throw rejected.reason;
        callback?.();
      })
      .catch((err) => {
        logger.warn({ err, hasSid: Boolean(sid) }, 'session destroy failed');
        callback?.(err);
      });
  }

  touch(sid: string, sess: SessionData, callback?: (err?: unknown) => void): void {
    void this.touchSession(sid, sess)
      .then(() => callback?.())
      .catch((err) => {
        logger.warn({ err, hasSid: Boolean(sid) }, 'session touch failed');
        callback?.(err);
      });
  }

  private async getSession(sid: string): Promise<SessionData | null> {
    const fromRedis = await tryRedisGet(sid);
    if (fromRedis) return fromRedis;

    const row = await prisma.adminSession.findUnique({ where: { id: sid } });
    if (!row) return null;
    if (row.expiresAt.getTime() <= Date.now()) {
      await this.destroyExpired(sid);
      return null;
    }
    return row.data as unknown as SessionData;
  }

  private async setSession(sid: string, sess: SessionData): Promise<void> {
    const expiresAt = sessionExpiresAt(sess);
    const serialized = JSON.stringify(sess);
    const redisWrite = redisConnection
      .set(redisKey(sid), serialized, 'PX', Math.max(expiresAt.getTime() - Date.now(), 1000))
      .then(() => true)
      .catch((err: unknown) => {
        logger.warn({ err }, 'redis session write failed; postgres fallback will be used');
        return false;
      });
    const pgWrite = prisma.adminSession
      .upsert({
        where: { id: sid },
        create: { id: sid, data: sess as never, expiresAt },
        update: { data: sess as never, expiresAt },
      })
      .then(() => true);

    const [redisOk, pgOk] = await Promise.all([redisWrite, pgWrite]);
    if (!redisOk && !pgOk) throw new Error('session write failed');
  }

  private async touchSession(sid: string, sess: SessionData): Promise<void> {
    const expiresAt = sessionExpiresAt(sess);
    await Promise.allSettled([
      redisConnection.pexpire(redisKey(sid), Math.max(expiresAt.getTime() - Date.now(), 1000)),
      prisma.adminSession.update({ where: { id: sid }, data: { expiresAt } }).catch((err: unknown) => {
        if (isPrismaNotFound(err)) return null;
        throw err;
      }),
    ]);
  }

  private async destroyExpired(sid: string): Promise<void> {
    await Promise.allSettled([
      redisConnection.del(redisKey(sid)),
      prisma.adminSession.delete({ where: { id: sid } }).catch((err: unknown) => {
        if (isPrismaNotFound(err)) return null;
        throw err;
      }),
    ]);
  }
}

async function tryRedisGet(sid: string): Promise<SessionData | null> {
  try {
    const value = await redisConnection.get(redisKey(sid));
    if (!value) return null;
    return JSON.parse(value) as SessionData;
  } catch (err) {
    logger.warn({ err }, 'redis session read failed; trying postgres fallback');
    return null;
  }
}

function redisKey(sid: string): string {
  return `${REDIS_PREFIX}${sid}`;
}

function sessionExpiresAt(sess: SessionData): Date {
  if (sess.expiresAt) {
    const parsed = new Date(sess.expiresAt);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const expires = sess.cookie?.expires;
  if (expires instanceof Date) return expires;
  if (typeof expires === 'string') {
    const parsed = new Date(expires);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(Date.now() + SESSION_TTL_MS);
}

function addMaxAgeToCookie(cookie: string): string {
  if (!cookie.startsWith(`${DASHBOARD_SESSION_COOKIE_NAME}=`)) return cookie;
  if (/;\s*Max-Age=/i.test(cookie)) return cookie;
  return cookie.replace(/;\s*Expires=/i, `; Max-Age=${SESSION_TTL_SECONDS}; Expires=`);
}

function isPrismaNotFound(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'P2025');
}
