import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@kda/db';
import { logger } from '../logger';
import { requireAuth } from '../auth/middleware';
import { SESSION_COOKIE_NAME, SESSION_COOKIE_OPTIONS, signAuthToken } from '../auth/jwt';

export const authRouter = Router();

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

  const token = signAuthToken({ sub: user.id, email: user.email, role: user.role });
  res.cookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);
  logger.info({ userId: user.id, email: user.email }, 'login success');
  res.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role },
  });
});

authRouter.post('/auth/logout', (req: Request, res: Response): void => {
  // Clear with the same attributes (sameSite/secure/domain/path) the cookie was set with,
  // otherwise the browser keeps the original cookie.
  res.clearCookie(SESSION_COOKIE_NAME, { ...SESSION_COOKIE_OPTIONS, maxAge: undefined });
  logger.info({ userId: req.auth?.sub ?? null }, 'logout: session cookie cleared');
  res.json({ ok: true });
});

// Short-lived token for the Socket.IO handshake. The dashboard fetches this over the
// first-party proxied API (so the session cookie is sent even on iOS Safari), then
// connects to the socket cross-site using the token instead of the cookie.
authRouter.get('/auth/socket-token', requireAuth, (req: Request, res: Response): void => {
  const { sub, email, role } = req.auth!;
  const token = signAuthToken({ sub, email, role });
  logger.info({ userId: sub }, 'socket-token issued');
  res.json({ token });
});

authRouter.get('/auth/me', requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.auth!.sub;
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) {
    res.status(404).json({ error: 'user_not_found' });
    return;
  }
  res.json({ user });
});
