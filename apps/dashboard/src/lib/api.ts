/** Typed fetch helpers for the backend REST API. */

const configuredBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
if (process.env.NODE_ENV === 'production' && !configuredBackendUrl) {
  throw new Error('NEXT_PUBLIC_BACKEND_URL is required in production');
}
if (process.env.NODE_ENV === 'production' && configuredBackendUrl && isLocalhostUrl(configuredBackendUrl)) {
  throw new Error('NEXT_PUBLIC_BACKEND_URL must not point to localhost in production');
}

// REST + media requests use SAME-ORIGIN relative paths. next.config rewrites
// proxy /api/* and /uploads/* to the backend, so Safari stores the session
// cookie as first-party on the dashboard origin instead of third-party on Render.
const BACKEND_URL = '';

// Absolute backend origin, used only for the direct Socket.IO connection (WebSockets
// can't be proxied through Vercel rewrites).
export const BACKEND_WS_ORIGIN = (configuredBackendUrl ?? 'http://localhost:3031').replace(/\/+$/, '');

export interface ApiRequestInit extends RequestInit {
  redirectOnUnauthorized?: boolean;
}

async function request<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const { redirectOnUnauthorized = true, ...fetchInit } = init ?? {};
  const headers = { 'content-type': 'application/json', ...(fetchInit.headers ?? {}) };
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...fetchInit,
    credentials: 'include',
    cache: fetchInit.cache ?? 'no-store',
    headers,
  });
  if (!res.ok) {
    const body = await res.text();
    if (
      redirectOnUnauthorized &&
      res.status === 401 &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/login')
    ) {
      const next = encodeURIComponent(`${window.location.pathname}${window.location.search}`);
      window.location.href = `/login?next=${next}`;
    }
    throw new ApiError(res.status, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`HTTP ${status}: ${body}`);
  }
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  try {
    const parsed = JSON.parse(error.body) as { error?: string; message?: string; errorId?: string };
    const message = parsed.message || parsed.error || fallback;
    return parsed.errorId ? `${message} (${parsed.errorId})` : message;
  } catch {
    return error.body || fallback;
  }
}

export const api = {
  get: <T>(path: string, init?: ApiRequestInit) => request<T>(path, init),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  uploadProductImage: async (file: File): Promise<{ url: string; publicId?: string; path: string }> => {
    const fd = new FormData();
    // Field name "photo" must match the backend's upload.single('photo'). Do NOT set a
    // Content-Type header — the browser sets multipart/form-data with the boundary.
    fd.append('photo', file);
    const res = await fetch(`${BACKEND_URL}/api/uploads/products`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  },
};

export const BACKEND_BASE_URL = BACKEND_URL;

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
