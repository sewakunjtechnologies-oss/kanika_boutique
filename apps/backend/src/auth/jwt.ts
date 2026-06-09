import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface AuthPayload {
  sub: string; // user id
  email: string;
  role: 'OWNER' | 'MANAGER' | 'ADMIN' | 'STAFF';
}

const TOKEN_TTL = '7d';

export function signAuthToken(payload: AuthPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyAuthToken(token: string): AuthPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    if (typeof decoded !== 'object' || decoded === null) return null;
    const { sub, email, role } = decoded as Partial<AuthPayload>;
    if (
      typeof sub !== 'string' ||
      typeof email !== 'string' ||
      (role !== 'OWNER' && role !== 'MANAGER' && role !== 'ADMIN' && role !== 'STAFF')
    ) {
      return null;
    }
    return { sub, email, role };
  } catch {
    return null;
  }
}
