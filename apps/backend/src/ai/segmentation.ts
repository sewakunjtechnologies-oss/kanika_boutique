import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '../config/env';
import { botError, botLog } from '../logger';

// Garment segmentation: strips the shared studio background (wall / furniture /
// floor) from product photos so downstream garment-design comparison is not
// collapsed by the identical backdrop every product shares. Env-gated and OFF by
// default — when disabled or on any failure, callers fall back to the original
// image, so behaviour is byte-identical to today unless explicitly enabled.
//
// The heavy model (`@imgly/background-removal-node` → onnxruntime-node, ~80–90MB
// model downloaded on first use) is loaded LAZILY via dynamic import only when the
// feature is on, so tests/builds never pull it in. A failed import (package not
// installed) degrades gracefully to null.

type Segmenter = (buffer: Buffer) => Promise<Buffer>;

let segmenterOverride: Segmenter | null = null;
let loadedSegmenter: Segmenter | null = null;

/** Test seam: inject a fake segmenter (or null to reset). */
export function __setSegmenterForTests(fn: Segmenter | null): void {
  segmenterOverride = fn;
  loadedSegmenter = null;
}

// sha256(image) → segmented JPEG buffer, or null when segmentation isn't usable.
// Caches BOTH outcomes so catalog images are segmented at most once per process
// (not re-run on every match call).
const cache = new Map<string, Buffer | null>();

export function clearSegmentationCache(): void {
  cache.clear();
}

export function getSegmentationCacheStats(): { entries: number; maxEntries: number } {
  return { entries: cache.size, maxEntries: env.IMAGE_SEGMENTATION_CACHE_MAX };
}

let moduleResolves: boolean | null = null;
/**
 * Diagnostic: whether the optional native segmentation package can be resolved at
 * runtime (it is installed-on-demand). Does NOT load the model. Cached.
 */
export function segmenterModuleResolves(): boolean {
  if (segmenterOverride) return true;
  if (moduleResolves === null) {
    try {
      require.resolve('@imgly/background-removal-node');
      moduleResolves = true;
    } catch {
      moduleResolves = false;
    }
  }
  return moduleResolves;
}

type RemoveBackground = (input: Buffer) => Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;

async function loadSegmenter(): Promise<Segmenter> {
  if (segmenterOverride) return segmenterOverride;
  if (loadedSegmenter) return loadedSegmenter;
  // Dynamic import via a NON-LITERAL specifier so TypeScript does not require the
  // optional native dependency to be installed at build time; a missing package
  // throws here and is handled by the caller (graceful fallback to the original).
  const moduleName = '@imgly/background-removal-node';
  const mod = (await import(moduleName)) as {
    removeBackground?: RemoveBackground;
    default?: { removeBackground?: RemoveBackground };
  };
  const removeBackground = mod.removeBackground ?? mod.default?.removeBackground;
  if (!removeBackground) throw new Error('removeBackground export not found');
  loadedSegmenter = async (buffer: Buffer): Promise<Buffer> => {
    const blob = await removeBackground(buffer);
    const cutout = Buffer.from(await blob.arrayBuffer());
    // Composite the transparent cutout onto flat white so perceptual hashes /
    // contrast stay stable for downstream comparison.
    return sharp(cutout).flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer();
  };
  return loadedSegmenter;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`segmentation timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function setCache(key: string, value: Buffer | null): void {
  if (cache.size >= env.IMAGE_SEGMENTATION_CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.delete(key);
  cache.set(key, value);
}

/**
 * Return a garment-isolated (background-removed) version of `buffer`, or null when
 * segmentation is disabled, times out, or fails. Never throws. Result is cached by
 * image content hash so each distinct image is segmented at most once per process.
 */
export async function segmentGarment(buffer: Buffer): Promise<Buffer | null> {
  if (!env.IMAGE_SEGMENTATION_ENABLED) return null;

  const key = crypto.createHash('sha256').update(buffer).digest('hex');
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const segmenter = await loadSegmenter();
    const result = await withTimeout(segmenter(buffer), env.IMAGE_SEGMENTATION_TIMEOUT_MS);
    setCache(key, result);
    botLog('IMAGE_SEGMENTED', { bytesIn: buffer.length, bytesOut: result.length, cached: false });
    return result;
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'segment_garment' });
    setCache(key, null);
    return null;
  }
}

/** Convenience: segmented buffer if available, else the original (graceful fallback). */
export async function segmentGarmentOrOriginal(buffer: Buffer): Promise<Buffer> {
  const segmented = await segmentGarment(buffer);
  return segmented ?? buffer;
}
