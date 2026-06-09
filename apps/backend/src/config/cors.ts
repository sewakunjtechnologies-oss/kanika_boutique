import { env } from './env';

// The production dashboard origin is always allowed, even if env is misconfigured.
const PROD_DASHBOARD_ORIGIN = 'https://kanika-boutique-dashboard.vercel.app';
const FUTURE_CUSTOM_DASHBOARD_ORIGIN = 'https://dashboard.kanikaboutique.com';

/** Trim whitespace and strip trailing slashes so "https://x/" and "https://x" compare equal. */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

/**
 * Build the allow-list of browser origins permitted to call the API and Socket.IO.
 * Sources (all optional, merged + de-duplicated): CORS_ORIGIN, CORS_ORIGINS (comma
 * separated), DASHBOARD_URL, PUBLIC_DASHBOARD_URL. The production dashboard origin is
 * always included; localhost dev origins are added outside production.
 */
export function buildAllowedOrigins(): string[] {
  const raw: string[] = [];
  if (process.env.CORS_ORIGIN) raw.push(process.env.CORS_ORIGIN);
  if (process.env.CORS_ORIGINS) raw.push(...process.env.CORS_ORIGINS.split(','));
  if (process.env.DASHBOARD_URL) raw.push(process.env.DASHBOARD_URL);
  raw.push(env.PUBLIC_DASHBOARD_URL);
  if (env.NODE_ENV === 'production') {
    raw.push(PROD_DASHBOARD_ORIGIN);
    raw.push(FUTURE_CUSTOM_DASHBOARD_ORIGIN);
  } else {
    raw.push('http://localhost:3000', 'http://localhost:3030');
  }
  return Array.from(new Set(raw.map(normalizeOrigin).filter((o) => o.length > 0)));
}

/** Shared, normalized list reused by the Express CORS middleware and the Socket.IO server. */
export const allowedOrigins = buildAllowedOrigins();
