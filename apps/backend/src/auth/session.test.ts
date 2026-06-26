import { describe, expect, test } from 'vitest';
import {
  addSessionCookieMaxAge,
  DASHBOARD_SESSION_COOKIE_NAME,
  getClearSessionCookieOptions,
  getSessionCookieOptions,
  SESSION_TTL_SECONDS,
} from './session';
import { TOKEN_TTL } from './jwt';

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

  test('socket JWT lifetime matches the one-week dashboard session lifetime', () => {
    expect(TOKEN_TTL).toBe('7d');
    expect(SESSION_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });

  test('adds Max-Age to express-session Set-Cookie output', () => {
    const cookie =
      'kda.sid=s%3Aabc.def; Path=/; Expires=Tue, 16 Jun 2026 10:00:00 GMT; HttpOnly; Secure; SameSite=None';
    expect(addSessionCookieMaxAge(cookie)).toContain('Max-Age=604800');
    expect(addSessionCookieMaxAge(cookie)).toContain('HttpOnly');
    expect(addSessionCookieMaxAge(cookie)).toContain('Secure');
    expect(addSessionCookieMaxAge(cookie)).toContain('SameSite=None');
  });

  test('clear cookie options match session cookie identity without setting replacement max age', () => {
    const sessionOptions = getSessionCookieOptions();
    const options = getClearSessionCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe(sessionOptions.path);
    expect(options.secure).toBe(sessionOptions.secure);
    expect(options.sameSite).toBe(sessionOptions.sameSite);
    expect(options.domain).toBe(sessionOptions.domain);
    expect('maxAge' in options).toBe(false);
  });
});
