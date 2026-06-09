/** Typed fetch helpers for the backend REST API. */

const configuredBackendUrl = process.env.NEXT_PUBLIC_BACKEND_URL;
if (process.env.NODE_ENV === 'production' && !configuredBackendUrl) {
  throw new Error('NEXT_PUBLIC_BACKEND_URL is required in production');
}
if (process.env.NODE_ENV === 'production' && configuredBackendUrl && isLocalhostUrl(configuredBackendUrl)) {
  throw new Error('NEXT_PUBLIC_BACKEND_URL must not point to localhost in production');
}

// REST + media requests use SAME-ORIGIN relative paths ("" base). next.config rewrites
// proxy /api/* and /uploads/* to the backend, so the browser only talks to this origin
// and the session cookie stays first-party (required for iOS Safari, which blocks
// third-party cookies). The empty base makes fetch("/api/...") hit this origin.
const BACKEND_URL = '';

// Absolute backend origin, used only for the direct Socket.IO connection (WebSockets
// can't be proxied through Vercel rewrites).
export const BACKEND_WS_ORIGIN = (configuredBackendUrl ?? 'http://localhost:3031').replace(/\/+$/, '');

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
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

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  uploadProductImage: async (file: File): Promise<{ url: string; path: string }> => {
    const fd = new FormData();
    // Field name "photo" must match the backend's upload.single('photo'). Do NOT set a
    // Content-Type header — the browser sets multipart/form-data with the boundary.
    fd.append('photo', file);
    const res = await fetch(`${BACKEND_URL}/api/uploads/products`, {
      method: 'POST',
      body: fd,
      credentials: 'include',
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
