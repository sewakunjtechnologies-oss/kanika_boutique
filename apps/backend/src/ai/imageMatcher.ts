import crypto from 'node:crypto';
import sharp from 'sharp';
import { env } from '../config/env';

const HASH_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };
const MIN_USABLE_DIMENSION_PX = 24;
const PIXEL_VIEW_SIZE = 64;
const PHASH_SIZE = 32;
const HASH_BITS = 64;
const MAX_FINGERPRINT_CACHE_ENTRIES = 512;

export const IMAGE_MATCH_ALGORITHM_VERSION = 'perceptual-v3-multistage';
export const IMAGE_MATCH_FEATURE_SCHEMA_VERSION = 3;
export const PERCEPTUAL_MATCH_THRESHOLD = 0.65;

export type ImageMatchType = 'EXACT_MATCH' | 'NEAR_DUPLICATE_MATCH' | 'GENERAL_MATCH';
export type ImageViewKind = 'full' | 'crop' | 'stretch' | 'trim';

interface ImageFeatureView {
  averageHash: bigint;
  differenceHash: bigint;
  perceptualHash: bigint;
  pixels: Buffer;
  colorPixels: Buffer;
  edges: Float32Array;
  histogram: number[];
}

export interface ImageFingerprint {
  rawSha256: string;
  decodedSha256: string;
  width: number;
  height: number;
  format: string | null;
  averageHash: bigint;
  differenceHash: bigint;
  perceptualHash: bigint;
  histogram: number[];
  views: Record<ImageViewKind, ImageFeatureView>;
  algorithmVersion: string;
  schemaVersion: number;
}

export interface SerializableImageFingerprint {
  rawSha256: string;
  decodedSha256: string;
  averageHash: string;
  differenceHash: string;
  perceptualHash: string;
  width: number;
  height: number;
  format: string | null;
  algorithmVersion: string;
  schemaVersion: number;
}

export interface ImageCandidate {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string;
  imageBuffer: Buffer;
  imageId?: string;
}

export interface ImageMatchScore {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string;
  imageId: string;
  confidence: number;
  matchType: ImageMatchType;
  averageHashSimilarity: number;
  differenceHashSimilarity: number;
  perceptualHashSimilarity: number;
  pixelSimilarity: number;
  colorPixelSimilarity: number;
  structuralSimilarity: number;
  edgeSimilarity: number;
  colorSimilarity: number;
  embeddingSimilarity: number | null;
  nearDuplicateScore: number;
  generalScore: number;
  rawHashMatch: boolean;
  decodedHashMatch: boolean;
  algorithmVersion: string;
  schemaVersion: number;
}

export interface ImageDiagnostics {
  width: number | null;
  height: number | null;
  format: string | null;
  sizeBytes: number;
  isUsable: boolean;
  reason?: string;
}

const fingerprintCache = new Map<string, Promise<ImageFingerprint> | ImageFingerprint>();

export async function fingerprintImage(buffer: Buffer): Promise<ImageFingerprint> {
  const rawSha256 = sha256Hex(buffer);
  const cached = fingerprintCache.get(rawSha256);
  if (cached) return cached;

  const pending = computeFingerprint(buffer, rawSha256).catch((err) => {
    fingerprintCache.delete(rawSha256);
    throw err;
  });
  setFingerprintCache(rawSha256, pending);
  const fingerprint = await pending;
  setFingerprintCache(rawSha256, fingerprint);
  return fingerprint;
}

export function serializeImageFingerprint(fingerprint: ImageFingerprint): SerializableImageFingerprint {
  return {
    rawSha256: fingerprint.rawSha256,
    decodedSha256: fingerprint.decodedSha256,
    averageHash: bigintToHex(fingerprint.averageHash),
    differenceHash: bigintToHex(fingerprint.differenceHash),
    perceptualHash: bigintToHex(fingerprint.perceptualHash),
    width: fingerprint.width,
    height: fingerprint.height,
    format: fingerprint.format,
    algorithmVersion: fingerprint.algorithmVersion,
    schemaVersion: fingerprint.schemaVersion,
  };
}

export function clearImageFingerprintCache(): void {
  fingerprintCache.clear();
}

export function getImageFingerprintCacheStats(): { entries: number; maxEntries: number } {
  return { entries: fingerprintCache.size, maxEntries: MAX_FINGERPRINT_CACHE_ENTRIES };
}

export async function inspectImageBuffer(buffer: Buffer): Promise<ImageDiagnostics> {
  try {
    const image = sharp(buffer, { failOn: 'none' }).rotate();
    const metadata = await image.metadata();
    const width = metadata.width ?? null;
    const height = metadata.height ?? null;
    if (!width || !height) {
      return {
        width,
        height,
        format: metadata.format ?? null,
        sizeBytes: buffer.length,
        isUsable: false,
        reason: 'missing_dimensions',
      };
    }
    if (width < MIN_USABLE_DIMENSION_PX || height < MIN_USABLE_DIMENSION_PX) {
      return {
        width,
        height,
        format: metadata.format ?? null,
        sizeBytes: buffer.length,
        isUsable: false,
        reason: 'too_small',
      };
    }

    const stats = await normalizedSharp(buffer)
      .resize(32, 32, { fit: 'contain', background: HASH_BACKGROUND })
      .stats();
    const meanStdev =
      stats.channels.slice(0, 3).reduce((sum, channel) => sum + (channel.stdev ?? 0), 0) /
      Math.max(stats.channels.slice(0, 3).length, 1);
    if (meanStdev < 1) {
      return {
        width,
        height,
        format: metadata.format ?? null,
        sizeBytes: buffer.length,
        isUsable: false,
        reason: 'blank_image',
      };
    }

    return { width, height, format: metadata.format ?? null, sizeBytes: buffer.length, isUsable: true };
  } catch {
    return { width: null, height: null, format: null, sizeBytes: buffer.length, isUsable: false, reason: 'decode_failed' };
  }
}

export async function rankImageMatches(
  queryBuffer: Buffer,
  candidates: ImageCandidate[],
): Promise<ImageMatchScore[]> {
  const query = await fingerprintImage(queryBuffer);
  const scores: ImageMatchScore[] = [];

  for (const candidate of candidates) {
    try {
      const candidateFingerprint = await fingerprintImage(candidate.imageBuffer);
      scores.push(scoreCandidate(query, candidateFingerprint, candidate));
    } catch {
      // One corrupt catalog image should not fail the whole matching run.
    }
  }

  return distinctBestProductScores(scores);
}

function scoreCandidate(
  query: ImageFingerprint,
  candidateFingerprint: ImageFingerprint,
  candidate: ImageCandidate,
): ImageMatchScore {
  const averageHashSimilarity = bestHashSimilarity(query, candidateFingerprint, 'averageHash');
  const differenceHashSimilarity = bestHashSimilarity(query, candidateFingerprint, 'differenceHash');
  const perceptualHashSimilarity = bestHashSimilarity(query, candidateFingerprint, 'perceptualHash');
  const pixelSimilarity = bestViewSimilarity(query, candidateFingerprint, normalizedPixelSimilarity);
  const colorPixelSimilarity = bestColorViewSimilarity(query, candidateFingerprint);
  const structuralSimilarity = bestViewSimilarity(query, candidateFingerprint, structuralSimilarityScore);
  const edgeSimilarity = bestEdgeSimilarity(query, candidateFingerprint);
  const colorSimilarity = bestColorSimilarity(query, candidateFingerprint);
  const rawHashMatch = query.rawSha256 === candidateFingerprint.rawSha256;
  const decodedHashMatch = query.decodedSha256 === candidateFingerprint.decodedSha256;
  const nearDuplicateScore = roundConfidence(
    0.24 * perceptualHashSimilarity +
      0.12 * differenceHashSimilarity +
      0.08 * averageHashSimilarity +
      0.18 * pixelSimilarity +
      0.18 * colorPixelSimilarity +
      0.11 * structuralSimilarity +
      0.09 * edgeSimilarity,
  );
  const generalScore = roundConfidence(
    0.22 * perceptualHashSimilarity +
      0.14 * differenceHashSimilarity +
      0.1 * averageHashSimilarity +
      0.15 * structuralSimilarity +
      0.13 * edgeSimilarity +
      0.21 * colorPixelSimilarity +
      0.05 * colorSimilarity,
  );
  const exactMatch = rawHashMatch || decodedHashMatch;
  const nearDuplicateMatch =
    !exactMatch &&
    nearDuplicateScore >= nearDuplicateFeatureThreshold() &&
    perceptualHashSimilarity >= env.IMAGE_NEAR_DUPLICATE_PHASH_THRESHOLD &&
    colorPixelSimilarity >= env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD &&
    edgeSimilarity >= env.IMAGE_NEAR_DUPLICATE_EDGE_THRESHOLD &&
    (pixelSimilarity >= env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD ||
      structuralSimilarity >= env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD);

  const matchType: ImageMatchType = exactMatch
    ? 'EXACT_MATCH'
    : nearDuplicateMatch
      ? 'NEAR_DUPLICATE_MATCH'
      : 'GENERAL_MATCH';
  const confidence = exactMatch ? 1 : matchType === 'NEAR_DUPLICATE_MATCH' ? nearDuplicateScore : generalScore;

  return {
    productId: candidate.productId,
    sku: candidate.sku,
    name: candidate.name,
    imageUrl: candidate.imageUrl,
    imageId: candidate.imageId ?? candidate.imageUrl,
    confidence: roundConfidence(confidence),
    matchType,
    averageHashSimilarity: roundConfidence(averageHashSimilarity),
    differenceHashSimilarity: roundConfidence(differenceHashSimilarity),
    perceptualHashSimilarity: roundConfidence(perceptualHashSimilarity),
    pixelSimilarity: roundConfidence(pixelSimilarity),
    colorPixelSimilarity: roundConfidence(colorPixelSimilarity),
    structuralSimilarity: roundConfidence(structuralSimilarity),
    edgeSimilarity: roundConfidence(edgeSimilarity),
    colorSimilarity: roundConfidence(colorSimilarity),
    embeddingSimilarity: null,
    nearDuplicateScore,
    generalScore,
    rawHashMatch,
    decodedHashMatch,
    algorithmVersion: IMAGE_MATCH_ALGORITHM_VERSION,
    schemaVersion: IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
  };
}

async function computeFingerprint(buffer: Buffer, rawSha256: string): Promise<ImageFingerprint> {
  const diagnostics = await inspectImageBuffer(buffer);
  if (!diagnostics.isUsable || diagnostics.width === null || diagnostics.height === null) {
    throw new Error(`Image is not usable for matching: ${diagnostics.reason ?? 'unknown'}`);
  }

  const decoded = await decodedPixelHash(buffer);
  const full = await buildFeatureView(buffer, 'full');
  const crop = await buildFeatureView(buffer, 'crop');
  const stretch = await buildFeatureView(buffer, 'stretch');
  const trim = await buildFeatureView(buffer, 'trim');

  return {
    rawSha256,
    decodedSha256: decoded.sha256,
    width: decoded.width,
    height: decoded.height,
    format: diagnostics.format,
    averageHash: full.averageHash,
    differenceHash: full.differenceHash,
    perceptualHash: full.perceptualHash,
    histogram: full.histogram,
    views: { full, crop, stretch, trim },
    algorithmVersion: IMAGE_MATCH_ALGORITHM_VERSION,
    schemaVersion: IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
  };
}

async function decodedPixelHash(buffer: Buffer): Promise<{ sha256: string; width: number; height: number }> {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: HASH_BACKGROUND })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const dimensions = Buffer.from(`${info.width}x${info.height}:${info.channels}:`);
  return {
    sha256: sha256Hex(Buffer.concat([dimensions, data])),
    width: info.width,
    height: info.height,
  };
}

async function buildFeatureView(buffer: Buffer, kind: ImageViewKind): Promise<ImageFeatureView> {
  const resize = viewResizeOptions(kind);
  const averagePixels = await normalizedSharp(buffer, kind === 'trim')
    .resize(8, 8, resize)
    .greyscale()
    .raw()
    .toBuffer();
  const differencePixels = await normalizedSharp(buffer, kind === 'trim')
    .resize(9, 8, resize)
    .greyscale()
    .raw()
    .toBuffer();
  const perceptualPixels = await normalizedSharp(buffer, kind === 'trim')
    .resize(PHASH_SIZE, PHASH_SIZE, resize)
    .greyscale()
    .raw()
    .toBuffer();
  const pixelView = await normalizedSharp(buffer, kind === 'trim')
    .resize(PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE, resize)
    .greyscale()
    .raw()
    .toBuffer();
  const colorPixelView = await normalizedSharp(buffer, kind === 'trim')
    .resize(PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE, resize)
    .raw()
    .toBuffer();
  const colorPixels = await normalizedSharp(buffer, kind === 'trim')
    .resize(32, 32, resize)
    .raw()
    .toBuffer();

  return {
    averageHash: averageHash(averagePixels),
    differenceHash: differenceHash(differencePixels),
    perceptualHash: perceptualHash(perceptualPixels),
    pixels: pixelView,
    colorPixels: colorPixelView,
    edges: sobelEdges(pixelView, PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE),
    histogram: colorHistogram(colorPixels),
  };
}

function normalizedSharp(buffer: Buffer, trim = false): sharp.Sharp {
  let image = sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: HASH_BACKGROUND })
    .toColourspace('srgb');
  if (trim) {
    image = image.trim({ background: HASH_BACKGROUND, threshold: 24 });
  }
  return image.normalise();
}

function viewResizeOptions(kind: ImageViewKind): sharp.ResizeOptions {
  if (kind === 'crop') return { fit: 'cover', kernel: 'lanczos3', position: 'centre' };
  if (kind === 'stretch') return { fit: 'fill', kernel: 'lanczos3' };
  return { fit: 'contain', background: HASH_BACKGROUND, kernel: 'lanczos3' };
}

function distinctBestProductScores(scores: ImageMatchScore[]): ImageMatchScore[] {
  const bestByProduct = new Map<string, ImageMatchScore>();
  for (const score of scores) {
    const existing = bestByProduct.get(score.productId);
    if (!existing || compareScores(score, existing) < 0) {
      bestByProduct.set(score.productId, score);
    }
  }
  return [...bestByProduct.values()].sort(compareScores);
}

function compareScores(a: ImageMatchScore, b: ImageMatchScore): number {
  const priorityDiff = matchPriority(b.matchType) - matchPriority(a.matchType);
  if (priorityDiff !== 0) return priorityDiff;
  return b.confidence - a.confidence;
}

function matchPriority(matchType: ImageMatchType): number {
  if (matchType === 'EXACT_MATCH') return 3;
  if (matchType === 'NEAR_DUPLICATE_MATCH') return 2;
  return 1;
}

function bestHashSimilarity(
  a: ImageFingerprint,
  b: ImageFingerprint,
  key: 'averageHash' | 'differenceHash' | 'perceptualHash',
): number {
  const pairs: Array<[ImageViewKind, ImageViewKind]> = [
    ['full', 'full'],
    ['crop', 'crop'],
    ['stretch', 'stretch'],
    ['trim', 'trim'],
    ['full', 'crop'],
    ['crop', 'full'],
    ['full', 'trim'],
    ['trim', 'full'],
  ];
  return Math.max(
    ...pairs.map(([left, right]) => 1 - hammingDistance(a.views[left][key], b.views[right][key]) / HASH_BITS),
  );
}

function bestViewSimilarity(
  a: ImageFingerprint,
  b: ImageFingerprint,
  metric: (left: Buffer, right: Buffer) => number,
): number {
  return Math.max(
    metric(a.views.full.pixels, b.views.full.pixels),
    metric(a.views.crop.pixels, b.views.crop.pixels),
    metric(a.views.stretch.pixels, b.views.stretch.pixels),
    metric(a.views.trim.pixels, b.views.trim.pixels),
    metric(a.views.full.pixels, b.views.crop.pixels),
    metric(a.views.crop.pixels, b.views.full.pixels),
    metric(a.views.full.pixels, b.views.trim.pixels),
    metric(a.views.trim.pixels, b.views.full.pixels),
  );
}

function bestColorViewSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(
    normalizedPixelSimilarity(a.views.full.colorPixels, b.views.full.colorPixels),
    normalizedPixelSimilarity(a.views.crop.colorPixels, b.views.crop.colorPixels),
    normalizedPixelSimilarity(a.views.stretch.colorPixels, b.views.stretch.colorPixels),
    normalizedPixelSimilarity(a.views.trim.colorPixels, b.views.trim.colorPixels),
    normalizedPixelSimilarity(a.views.full.colorPixels, b.views.crop.colorPixels),
    normalizedPixelSimilarity(a.views.crop.colorPixels, b.views.full.colorPixels),
    normalizedPixelSimilarity(a.views.full.colorPixels, b.views.trim.colorPixels),
    normalizedPixelSimilarity(a.views.trim.colorPixels, b.views.full.colorPixels),
  );
}

function bestEdgeSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(
    cosineSimilarity(Array.from(a.views.full.edges), Array.from(b.views.full.edges)),
    cosineSimilarity(Array.from(a.views.crop.edges), Array.from(b.views.crop.edges)),
    cosineSimilarity(Array.from(a.views.stretch.edges), Array.from(b.views.stretch.edges)),
    cosineSimilarity(Array.from(a.views.trim.edges), Array.from(b.views.trim.edges)),
    cosineSimilarity(Array.from(a.views.full.edges), Array.from(b.views.crop.edges)),
    cosineSimilarity(Array.from(a.views.crop.edges), Array.from(b.views.full.edges)),
    cosineSimilarity(Array.from(a.views.full.edges), Array.from(b.views.trim.edges)),
    cosineSimilarity(Array.from(a.views.trim.edges), Array.from(b.views.full.edges)),
  );
}

function bestColorSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(
    cosineSimilarity(a.views.full.histogram, b.views.full.histogram),
    cosineSimilarity(a.views.crop.histogram, b.views.crop.histogram),
    cosineSimilarity(a.views.trim.histogram, b.views.trim.histogram),
  );
}

function averageHash(pixels: Buffer): bigint {
  const avg = pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  let hash = 0n;
  for (const value of pixels) {
    hash <<= 1n;
    if (value >= avg) hash |= 1n;
  }
  return hash;
}

function differenceHash(pixels: Buffer): bigint {
  let hash = 0n;
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const left = pixels[y * 9 + x] ?? 0;
      const right = pixels[y * 9 + x + 1] ?? 0;
      hash <<= 1n;
      if (left > right) hash |= 1n;
    }
  }
  return hash;
}

function perceptualHash(pixels: Buffer): bigint {
  const coefficients = dct2d(pixels, PHASH_SIZE, 8);
  const lowFrequency = coefficients.slice(1);
  const median = sortedMedian(lowFrequency);
  let hash = 0n;
  for (const coefficient of coefficients) {
    hash <<= 1n;
    if (coefficient > median) hash |= 1n;
  }
  return hash;
}

function dct2d(pixels: Buffer, size: number, keep: number): number[] {
  const values: number[] = [];
  for (let u = 0; u < keep; u += 1) {
    for (let v = 0; v < keep; v += 1) {
      let sum = 0;
      for (let x = 0; x < size; x += 1) {
        for (let y = 0; y < size; y += 1) {
          const pixel = pixels[y * size + x] ?? 0;
          sum +=
            pixel *
            Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
            Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
        }
      }
      const cu = u === 0 ? 1 / Math.sqrt(2) : 1;
      const cv = v === 0 ? 1 / Math.sqrt(2) : 1;
      values.push((2 / size) * cu * cv * sum);
    }
  }
  return values;
}

function hammingDistance(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function normalizedPixelSimilarity(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let sumSquared = 0;
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    sumSquared += diff * diff;
  }
  const rmse = Math.sqrt(sumSquared / length) / 255;
  return clamp01(1 - rmse);
}

function structuralSimilarityScore(a: Buffer, b: Buffer): number {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < length; i += 1) {
    meanA += a[i] ?? 0;
    meanB += b[i] ?? 0;
  }
  meanA /= length;
  meanB /= length;

  let varianceA = 0;
  let varianceB = 0;
  let covariance = 0;
  for (let i = 0; i < length; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    varianceA += da * da;
    varianceB += db * db;
    covariance += da * db;
  }
  varianceA /= length - 1 || 1;
  varianceB /= length - 1 || 1;
  covariance /= length - 1 || 1;

  const c1 = 6.5025;
  const c2 = 58.5225;
  const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
  const denominator = (meanA * meanA + meanB * meanB + c1) * (varianceA + varianceB + c2);
  return denominator === 0 ? 0 : clamp01((numerator / denominator + 1) / 2);
}

function sobelEdges(pixels: Buffer, width: number, height: number): Float32Array {
  const edges = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const tl = pixels[(y - 1) * width + (x - 1)] ?? 0;
      const tc = pixels[(y - 1) * width + x] ?? 0;
      const tr = pixels[(y - 1) * width + (x + 1)] ?? 0;
      const ml = pixels[y * width + (x - 1)] ?? 0;
      const mr = pixels[y * width + (x + 1)] ?? 0;
      const bl = pixels[(y + 1) * width + (x - 1)] ?? 0;
      const bc = pixels[(y + 1) * width + x] ?? 0;
      const br = pixels[(y + 1) * width + (x + 1)] ?? 0;
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      edges[i] = Math.min(255, Math.sqrt(gx * gx + gy * gy));
    }
  }
  return edges;
}

function colorHistogram(pixels: Buffer): number[] {
  const bins = new Array<number>(64).fill(0);
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const r = Math.min(3, Math.floor((pixels[i] ?? 0) / 64));
    const g = Math.min(3, Math.floor((pixels[i + 1] ?? 0) / 64));
    const b = Math.min(3, Math.floor((pixels[i + 2] ?? 0) / 64));
    const index = r * 16 + g * 4 + b;
    bins[index] = (bins[index] ?? 0) + 1;
  }
  const total = pixels.length / 3 || 1;
  return bins.map((count) => count / total);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    aNorm += (a[i] ?? 0) ** 2;
    bNorm += (b[i] ?? 0) ** 2;
  }
  if (aNorm === 0 || bNorm === 0) return 0;
  return clamp01(dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm)));
}

function sortedMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function nearDuplicateFeatureThreshold(): number {
  return env.IMAGE_NEAR_DUPLICATE_FEATURE_THRESHOLD ?? env.IMAGE_NEAR_DUPLICATE_THRESHOLD ?? 0.88;
}

function sha256Hex(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function bigintToHex(value: bigint): string {
  return value.toString(16).padStart(16, '0');
}

function setFingerprintCache(key: string, value: Promise<ImageFingerprint> | ImageFingerprint): void {
  if (!fingerprintCache.has(key) && fingerprintCache.size >= MAX_FINGERPRINT_CACHE_ENTRIES) {
    const oldest = fingerprintCache.keys().next().value;
    if (oldest) fingerprintCache.delete(oldest);
  }
  fingerprintCache.set(key, value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
