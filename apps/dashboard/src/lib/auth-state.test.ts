import { describe, expect, test } from 'vitest';
import { ApiError } from './api';
import { restoreAuthSession, shouldRedirectToLogin } from './auth-state';

describe('dashboard auth session restoration', () => {
  test('restores authenticated user and role after /auth/me succeeds', async () => {
    const state = await restoreAuthSession(async () => ({
      authenticated: true,
      user: { id: 'admin_1', email: 'owner@example.com', name: 'Owner', role: 'OWNER' },
    }));

    expect(state).toEqual({
      status: 'authenticated',
      user: { id: 'admin_1', email: 'owner@example.com', name: 'Owner', role: 'OWNER' },
    });
    expect(shouldRedirectToLogin(state)).toBe(false);
  });

  test('expired or missing session redirects only after /auth/me returns 401', async () => {
    const state = await restoreAuthSession(async () => {
      throw new ApiError(401, '{"authenticated":false}');
    });

    expect(state).toEqual({ status: 'unauthenticated', user: null });
    expect(shouldRedirectToLogin(state)).toBe(true);
  });

  test('network/server errors do not become an automatic logout', async () => {
    const state = await restoreAuthSession(async () => {
      throw new ApiError(503, '{"error":"temporarily_unavailable"}');
    });

    expect(state.status).toBe('error');
    expect(shouldRedirectToLogin(state)).toBe(false);
  });
});
