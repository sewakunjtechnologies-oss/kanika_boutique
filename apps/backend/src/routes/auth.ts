import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@kda/db';
import { logger } from '../logger';
import { requireAuth } from '../auth/middleware';
import { signAuthToken } from '../auth/jwt';
import {
  DASHBOARD_SESSION_COOKIE_NAME,
  destroySession,
  getClearSessionCookieOptions,
  regenerateSession,
  saveSession,
  SESSION_TTL_SECONDS,
} from '../auth/session';

export const authRouter = Router();

authRouter.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, private');
  next();
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

authRouter.post('/auth/login', async (req: Request, res: Response): Promise<void> => {
  const parsed = LoginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const { email, password } = parsed.data;

  const user = await prisma.adminUser.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, name: true, role: true, passwordHash: true },
  });
  if (!user) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    res.status(401).json({ error: 'invalid_credentials' });
    return;
  }

  await regenerateSession(req);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  req.session.cookie.maxAge = SESSION_TTL_SECONDS * 1000;
  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.role = user.role;
  req.session.createdAt = new Date().toISOString();
  req.session.expiresAt = expiresAt.toISOString();

  try {
    await saveSession(req);
  } catch (err) {
    logger.error({ err, userId: user.id }, 'session save failed after login');
    res.status(500).json({ error: 'session_save_failed' });
    return;
  }

  logger.info(
    { userId: user.id, email: user.email, ttlDays: 7 },
    'Session created for user, expires in 7 days',
  );
  res.json({
    authenticated: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

authRouter.post('/auth/logout', async (req: Request, res: Response): Promise<void> => {
  const userId = req.session?.userId ?? null;
  await destroySession(req);
  res.clearCookie(DASHBOARD_SESSION_COOKIE_NAME, getClearSessionCookieOptions());
  logger.info({ userId }, 'logout: server session destroyed');
  res.json({ ok: true });
});

// Short-lived token for the Socket.IO handshake. The browser session remains
// server-side; this token is only for direct cross-site WebSocket auth.
authRouter.get('/auth/socket-token', requireAuth, (req: Request, res: Response): void => {
  const { sub, email, role } = req.auth!;
  const token = signAuthToken({ sub, email, role });
  logger.info({ userId: sub }, 'socket-token issued');
  res.json({ token });
});

authRouter.get('/auth/me', async (req: Request, res: Response): Promise<void> => {
  const userId = req.session?.userId;
  logger.debug({ sessionExists: Boolean(userId) }, '/me session exists');
  if (!userId) {
    res.status(401).json({ authenticated: false });
    return;
  }

  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) {
    await destroySession(req);
    res.clearCookie(DASHBOARD_SESSION_COOKIE_NAME, getClearSessionCookieOptions());
    res.status(401).json({ authenticated: false });
    return;
  }
  logger.debug({ userId: user.id }, 'auth me: authenticated');
  res.json({
    authenticated: true,
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});
