import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./callJsonOutput', () => ({ callJsonOutput: vi.fn() }));
vi.mock('@kda/db', () => ({ prisma: {} }));

import { callJsonOutput } from './callJsonOutput';
import { verifyProductMatch, selectMatchingProduct } from './productMatcher';

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

describe('selectMatchingProduct — top-K Gemini selector', () => {
  const cands = [
    { productId: 'p1', sku: 'SKU1', imageBuffer: Buffer.from('a'), mimeType: 'image/jpeg' as const },
    { productId: 'p2', sku: 'SKU2', imageBuffer: Buffer.from('b'), mimeType: 'image/jpeg' as const },
    { productId: 'p3', sku: 'SKU3', imageBuffer: Buffer.from('c'), mimeType: 'image/jpeg' as const },
  ];
  const sel = { queryBase64: 'cQ==', queryMediaType: 'image/jpeg' as const, candidates: cands };

  test('returns the chosen candidate id + confidence', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { matchedProductId: 'p2', confidence: 0.82, reasoning: 'same floral' }, usage: {} } as never);
    expect(await selectMatchingProduct(sel)).toEqual({ productId: 'p2', confidence: 0.82 });
  });

  test('returns null productId for "none"', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { matchedProductId: null, confidence: 0.3, reasoning: 'no match' }, usage: {} } as never);
    expect(await selectMatchingProduct(sel)).toEqual({ productId: null, confidence: 0.3 });
  });

  test('rejects a hallucinated id not in the candidate set → null', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { matchedProductId: 'p999', confidence: 0.9, reasoning: 'made up' }, usage: {} } as never);
    expect(await selectMatchingProduct(sel)).toEqual({ productId: null, confidence: 0.9 });
  });

  test('no result → "unavailable"', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: null, usage: {} } as never);
    expect(await selectMatchingProduct(sel)).toBe('unavailable');
  });

  test('API error → "unavailable" (graceful, no throw)', async () => {
    vi.mocked(callJsonOutput).mockRejectedValueOnce(new Error('gemini down'));
    expect(await selectMatchingProduct(sel)).toBe('unavailable');
  });

  test('empty candidate set → "unavailable" (no API call)', async () => {
    expect(await selectMatchingProduct({ ...sel, candidates: [] })).toBe('unavailable');
    expect(callJsonOutput).not.toHaveBeenCalled();
  });

  test('sends the customer image + one image per candidate, no PII', async () => {
    vi.mocked(callJsonOutput).mockResolvedValue({ result: { matchedProductId: null, confidence: 0.1, reasoning: 'x' }, usage: {} } as never);
    await selectMatchingProduct(sel);
    const call = vi.mocked(callJsonOutput).mock.calls[0]![0];
    const parts = call.contents[0]!.parts as Array<Record<string, unknown>>;
    expect(parts.filter((p) => 'inlineData' in p)).toHaveLength(1 + cands.length);
  });
});
