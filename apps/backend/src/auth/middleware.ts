import type { NextFunction, Request, Response } from 'express';
import type { AdminRole } from '@kda/db';
import { prisma } from '@kda/db';
import { logger } from '../logger';

export interface AuthPayload {
  sub: string;
  email: string;
  role: AdminRole;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: AdminRole;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthPayload;
    user?: AuthUser;
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) {
    logger.debug({ hasSessionId: Boolean(req.sessionID) }, 'auth blocked: session missing user');
    res.status(401).json({ authenticated: false });
    return;
  }

  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) {
    logger.warn({ userId }, 'auth blocked: session user not found');
    req.session.destroy(() => undefined);
    res.status(401).json({ authenticated: false });
    return;
  }

  req.user = user;
  req.auth = { sub: user.id, email: user.email, role: user.role };
  next();
}

export type RoleName = AuthPayload['role'];

export function isOwnerRole(role: RoleName | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function isManagerOrOwnerRole(role: RoleName | undefined): boolean {
  return isOwnerRole(role) || role === 'MANAGER';
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  ensureAuth(req, res, next, () => {
    if (!isOwnerRole(req.auth?.role)) {
      res.status(403).json({ error: 'forbidden', requiredRole: 'OWNER' });
      return;
    }
    next();
  });
}

export function requireManagerOrOwner(req: Request, res: Response, next: NextFunction): void {
  ensureAuth(req, res, next, () => {
    if (!isManagerOrOwnerRole(req.auth?.role)) {
      res.status(403).json({ error: 'forbidden', requiredRole: 'OWNER_OR_MANAGER' });
      return;
    }
    next();
  });
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const userId = req.session?.userId;
  if (!userId) {
    next();
    return;
  }
  const user = await prisma.adminUser.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (user) {
    req.user = user;
    req.auth = { sub: user.id, email: user.email, role: user.role };
  }
  next();
}

function ensureAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  onAuthed: () => void,
): void {
  if (req.auth) {
    onAuthed();
    return;
  }
  void requireAuth(req, res, (err?: unknown) => {
    if (err) {
      next(err);
      return;
    }
    if (!req.auth) return;
    onAuthed();
  });
}
