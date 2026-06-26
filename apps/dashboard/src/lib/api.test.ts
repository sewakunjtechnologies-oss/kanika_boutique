import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from './api';

describe('dashboard API client', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('always includes credentials and disables response caching', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/api/auth/me');

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/me',
      expect.objectContaining({
        credentials: 'include',
        cache: 'no-store',
      }),
    );
  });

  test('cannot be forced to omit cookies by a per-call override', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/api/orders', { credentials: 'omit' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/orders',
      expect.objectContaining({
        credentials: 'include',
      }),
    );
  });

  test('401 response rejects safely for the auth restoration call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

    await expect(
      api.get('/api/auth/me', { redirectOnUnauthorized: false }),
    ).rejects.toMatchObject({ status: 401, body: 'unauthorized' });
  });
});
