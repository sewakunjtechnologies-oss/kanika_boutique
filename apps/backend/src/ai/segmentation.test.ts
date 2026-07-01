import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';
import {
  __resetSegmentationBreakerForTests,
  __setSegmenterForTests,
  clearSegmentationCache,
  getSegmentationCacheStats,
  isSegmentationDegraded,
  segmentGarment,
  segmentGarmentOrOriginal,
} from './segmentation';

const original = Buffer.from('original-image-bytes');
const segmented = Buffer.from('segmented-garment-bytes');

beforeEach(() => {
  clearSegmentationCache();
  __setSegmenterForTests(null);
  __resetSegmentationBreakerForTests();
  env.IMAGE_SEGMENTATION_ENABLED = true;
  env.IMAGE_SEGMENTATION_TIMEOUT_MS = 1000;
  env.IMAGE_SEGMENTATION_CACHE_MAX = 256;
  env.IMAGE_SEGMENTATION_BREAKER_COOLDOWN_MS = 300_000;
});
afterEach(() => {
  __setSegmenterForTests(null);
  clearSegmentationCache();
  __resetSegmentationBreakerForTests();
  env.IMAGE_SEGMENTATION_ENABLED = false;
});

describe('segmentGarment — env-gated, cached, graceful', () => {
  test('disabled → returns null (no segmenter call), fallback uses original buffer', async () => {
    env.IMAGE_SEGMENTATION_ENABLED = false;
    const seg = vi.fn(async () => segmented);
    __setSegmenterForTests(seg);

    expect(await segmentGarment(original)).toBeNull();
    expect(seg).not.toHaveBeenCalled();
    // segmentGarmentOrOriginal returns the SAME buffer object (identity preserved).
    expect(await segmentGarmentOrOriginal(original)).toBe(original);
  });

  test('enabled but @imgly package absent → real dynamic import fails → null, fallback to original', async () => {
    // No segmenter override → loadSegmenter() does the real dynamic import of the
    // optional native dep, which is NOT installed, so it must degrade gracefully.
    __setSegmenterForTests(null);
    expect(await segmentGarment(original)).toBeNull();
    expect(await segmentGarmentOrOriginal(original)).toBe(original);
  });

  test('enabled + success → returns segmented buffer', async () => {
    __setSegmenterForTests(async () => segmented);
    expect(await segmentGarment(original)).toBe(segmented);
    expect(await segmentGarmentOrOriginal(original)).toBe(segmented);
  });

  test('result is cached by content hash — segmenter invoked once per distinct image', async () => {
    const seg = vi.fn(async () => segmented);
    __setSegmenterForTests(seg);

    await segmentGarment(original);
    await segmentGarment(Buffer.from('original-image-bytes')); // same content, new Buffer
    await segmentGarment(original);
    expect(seg).toHaveBeenCalledTimes(1);
    expect(getSegmentationCacheStats().entries).toBe(1);

    await segmentGarment(Buffer.from('a-different-image'));
    expect(seg).toHaveBeenCalledTimes(2);
  });

  test('segmenter throws → returns null (graceful), fallback uses original', async () => {
    __setSegmenterForTests(async () => {
      throw new Error('onnx blew up');
    });
    expect(await segmentGarment(original)).toBeNull();
    expect(await segmentGarmentOrOriginal(original)).toBe(original);
  });

  test('failure is negatively cached (does not retry the same image)', async () => {
    const seg = vi.fn(async () => {
      throw new Error('bad image');
    });
    __setSegmenterForTests(seg);
    await segmentGarment(original);
    await segmentGarment(original);
    expect(seg).toHaveBeenCalledTimes(1);
  });

  test('timeout → returns null (never hangs the match)', async () => {
    env.IMAGE_SEGMENTATION_TIMEOUT_MS = 30;
    __setSegmenterForTests(
      () => new Promise<Buffer>((resolve) => setTimeout(() => resolve(segmented), 500)),
    );
    expect(await segmentGarment(original)).toBeNull();
  });

  test('cache evicts oldest beyond IMAGE_SEGMENTATION_CACHE_MAX', async () => {
    env.IMAGE_SEGMENTATION_CACHE_MAX = 2;
    __setSegmenterForTests(async () => segmented);
    await segmentGarment(Buffer.from('img-1'));
    await segmentGarment(Buffer.from('img-2'));
    await segmentGarment(Buffer.from('img-3'));
    expect(getSegmentationCacheStats().entries).toBe(2);
  });
});

describe('segmentation circuit breaker (perf safety net)', () => {
  test('a failed segmentation trips the breaker → subsequent images skip to the fast path', async () => {
    const seg = vi.fn(async () => {
      throw new Error('onnx grind');
    });
    __setSegmenterForTests(seg);

    expect(await segmentGarment(Buffer.from('img-A'))).toBeNull();
    expect(isSegmentationDegraded()).toBe(true);

    // A DIFFERENT image must NOT invoke the model again while degraded.
    expect(await segmentGarment(Buffer.from('img-B'))).toBeNull();
    expect(await segmentGarmentOrOriginal(original)).toBe(original);
    expect(seg).toHaveBeenCalledTimes(1); // only the first (failing) call ever ran
  });

  test('a slow segmentation (exceeds the per-image cap) trips the breaker', async () => {
    env.IMAGE_SEGMENTATION_TIMEOUT_MS = 20;
    // Resolves AFTER the cap → withTimeout rejects → breaker trips.
    __setSegmenterForTests(() => new Promise<Buffer>((r) => setTimeout(() => r(segmented), 200)));
    expect(await segmentGarment(Buffer.from('slow'))).toBeNull();
    expect(isSegmentationDegraded()).toBe(true);
  });

  test('breaker cooldown = 0 disables the breaker (never degrades)', async () => {
    env.IMAGE_SEGMENTATION_BREAKER_COOLDOWN_MS = 0;
    const seg = vi.fn(async () => {
      throw new Error('boom');
    });
    __setSegmenterForTests(seg);
    await segmentGarment(Buffer.from('x1'));
    expect(isSegmentationDegraded()).toBe(false);
    await segmentGarment(Buffer.from('x2')); // still attempts (breaker off)
    expect(seg).toHaveBeenCalledTimes(2);
  });
});
