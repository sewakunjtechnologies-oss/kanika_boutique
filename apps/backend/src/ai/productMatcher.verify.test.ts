import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./callJsonOutput', () => ({ callJsonOutput: vi.fn() }));
vi.mock('@kda/db', () => ({ prisma: {} }));

import { callJsonOutput } from './callJsonOutput';
import { verifyProductMatch } from './productMatcher';

const candidate = { imageBuffer: Buffer.from('cand'), mimeType: 'image/jpeg' as const, sku: 'SKU-1' };
const query = { queryBase64: Buffer.from('q').toString('base64'), queryMediaType: 'image/jpeg' as const, candidate };

beforeEach(() => vi.mocked(callJsonOutput).mockReset());

describe('verifyProductMatch — constrained Gemini same-product check', () => {
  test('returns "same" only on a confident positive verdict', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { sameProduct: true, confidence: 0.9, reasoning: 'x' }, usage: {} } as never);
    expect(await verifyProductMatch(query)).toBe('same');
  });

  test('low-confidence positive is treated as "different" (strict gate)', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { sameProduct: true, confidence: 0.5, reasoning: 'x' }, usage: {} } as never);
    expect(await verifyProductMatch(query)).toBe('different');
  });

  test('negative verdict → "different"', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { sameProduct: false, confidence: 0.95, reasoning: 'diff colour' }, usage: {} } as never);
    expect(await verifyProductMatch(query)).toBe('different');
  });

  test('no result → "unavailable" (caller falls back to confirmation gate)', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: null, usage: {} } as never);
    expect(await verifyProductMatch(query)).toBe('unavailable');
  });

  test('API error → "unavailable" (graceful fallback, no throw)', async () => {
    vi.mocked(callJsonOutput).mockRejectedValueOnce(new Error('gemini down'));
    expect(await verifyProductMatch(query)).toBe('unavailable');
  });

  test('sends exactly two images and no customer PII/text beyond the prompt', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { sameProduct: false, confidence: 0.9, reasoning: 'x' }, usage: {} } as never);
    await verifyProductMatch(query);
    const call = vi.mocked(callJsonOutput).mock.calls[0]![0];
    const parts = call.contents[0]!.parts as Array<Record<string, unknown>>;
    const images = parts.filter((p) => 'inlineData' in p);
    expect(images).toHaveLength(2);
  });
});
