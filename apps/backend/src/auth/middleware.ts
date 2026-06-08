import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE_NAME, verifyAuthToken, type AuthPayload } from './jwt';

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthPayload;
  }
}

/** Reject if no valid JWT in the session cookie. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (!token) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const payload = verifyAuthToken(token);
  if (!payload) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  req.auth = payload;
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
  if (!req.auth) {
    requireAuth(req, res, () => undefined);
    if (!req.auth) return;
  }
  if (!isOwnerRole(req.auth.role)) {
    res.status(403).json({ error: 'forbidden', requiredRole: 'OWNER' });
    return;
  }
  next();
}

export function requireManagerOrOwner(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    requireAuth(req, res, () => undefined);
    if (!req.auth) return;
  }
  if (!isManagerOrOwnerRole(req.auth.role)) {
    res.status(403).json({ error: 'forbidden', requiredRole: 'OWNER_OR_MANAGER' });
    return;
  }
  next();
}

/** Permissive: attaches auth if present, never rejects. */
export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[SESSION_COOKIE_NAME] as string | undefined;
  if (token) {
    const payload = verifyAuthToken(token);
    if (payload) req.auth = payload;
  }
  next();
}
