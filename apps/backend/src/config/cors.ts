import { env } from './env';

/** Trim whitespace and strip trailing slashes so "https://x/" and "https://x" compare equal. */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export interface CorsOriginInput {
  nodeEnv: 'development' | 'test' | 'production';
  publicDashboardUrl: string;
  corsOrigin?: string;
  corsOrigins?: string;
  dashboardUrl?: string;
}

export function buildAllowedOriginsFromInput(input: CorsOriginInput): string[] {
  if (input.nodeEnv === 'production') {
    return Array.from(new Set([normalizeOrigin(input.publicDashboardUrl)].filter(Boolean)));
  }

  const raw: string[] = [];
  if (input.corsOrigin) raw.push(input.corsOrigin);
  if (input.corsOrigins) raw.push(...input.corsOrigins.split(','));
  if (input.dashboardUrl) raw.push(input.dashboardUrl);
  raw.push(input.publicDashboardUrl, 'http://localhost:3000', 'http://localhost:3030');
  return Array.from(new Set(raw.map(normalizeOrigin).filter((o) => o.length > 0)));
}

/**
 * Build the allow-list of browser origins permitted to call the API and Socket.IO.
 * Production is deliberately strict: only PUBLIC_DASHBOARD_URL is allowed. To move to
 * a custom dashboard domain, change PUBLIC_DASHBOARD_URL instead of widening CORS.
 */
export function buildAllowedOrigins(): string[] {
  return buildAllowedOriginsFromInput({
    nodeEnv: env.NODE_ENV,
    publicDashboardUrl: env.PUBLIC_DASHBOARD_URL,
    corsOrigin: process.env.CORS_ORIGIN,
    corsOrigins: process.env.CORS_ORIGINS,
    dashboardUrl: process.env.DASHBOARD_URL,
  });
}

/** Shared, normalized list reused by the Express CORS middleware and the Socket.IO server. */
export const allowedOrigins = buildAllowedOrigins();
