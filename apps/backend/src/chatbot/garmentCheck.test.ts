import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../ai/callJsonOutput', () => ({ callJsonOutput: vi.fn() }));

import { callJsonOutput } from '../ai/callJsonOutput';
import { env } from '../config/env';
import { isGarmentImage, shouldRunGarmentCheck } from './garmentCheck';

const originalKey = env.GEMINI_API_KEY;
beforeEach(() => {
  env.GEMINI_API_KEY = 'test-key';
});
afterEach(() => {
  env.GEMINI_API_KEY = originalKey;
  vi.restoreAllMocks();
});

describe('shouldRunGarmentCheck (pure gate)', () => {
  test('runs only when enabled AND score is at/below the ceiling', () => {
    expect(shouldRunGarmentCheck(0.1, true, 0.15)).toBe(true);
    expect(shouldRunGarmentCheck(0.15, true, 0.15)).toBe(true);
    expect(shouldRunGarmentCheck(0.2, true, 0.15)).toBe(false); // score too high → likely a real match tail
    expect(shouldRunGarmentCheck(0.1, false, 0.15)).toBe(false); // feature off
  });
});

describe('isGarmentImage', () => {
  test('a confident "not a garment" returns false (caller will suppress)', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { isGarment: false }, usage: undefined } as never);
    expect(await isGarmentImage('base64', 'image/jpeg')).toBe(false);
  });

  test('a garment returns true (caller escalates as normal)', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { isGarment: true }, usage: undefined } as never);
    expect(await isGarmentImage('base64', 'image/jpeg')).toBe(true);
  });

  test('a model failure returns null so the caller never suppresses on uncertainty', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: null, usage: undefined } as never);
    expect(await isGarmentImage('base64', 'image/jpeg')).toBeNull();
  });
});
