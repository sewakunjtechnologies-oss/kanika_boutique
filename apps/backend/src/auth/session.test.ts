import { describe, expect, test } from 'vitest';
import {
  DASHBOARD_SESSION_COOKIE_NAME,
  getClearSessionCookieOptions,
  getSessionCookieOptions,
} from './session';

describe('dashboard session cookie settings', () => {
  test('uses signed server-side session cookie name', () => {
    expect(DASHBOARD_SESSION_COOKIE_NAME).toBe('kda.sid');
  });

  test('sets secure http-only one-week cookie options', () => {
    const options = getSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect(options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
    expect(options.sameSite).toMatch(/^(lax|none|strict)$/);
  });

  test('clear cookie options do not set a replacement max age', () => {
    const options = getClearSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect('maxAge' in options).toBe(false);
  });
});
