import { describe, expect, test } from 'vitest';
import {
  addSessionCookieMaxAge,
  DASHBOARD_SESSION_COOKIE_NAME,
  getClearSessionCookieOptions,
  getSessionCookieOptions,
  SESSION_TTL_SECONDS,
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
    expect(SESSION_TTL_SECONDS).toBe(604800);
    expect(options.sameSite).toMatch(/^(lax|none|strict)$/);
  });

  test('adds Max-Age to express-session Set-Cookie output', () => {
    const cookie =
      'kda.sid=s%3Aabc.def; Path=/; Expires=Tue, 16 Jun 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=None';
    expect(addSessionCookieMaxAge(cookie)).toContain('Max-Age=604800');
  });

  test('clear cookie options do not set a replacement max age', () => {
    const options = getClearSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe('/');
    expect('maxAge' in options).toBe(false);
  });
});
