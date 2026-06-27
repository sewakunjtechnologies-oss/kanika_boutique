import sharp from 'sharp';

const HASH_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };
const MIN_USABLE_DIMENSION_PX = 24;

export interface ImageFingerprint {
  averageHash: bigint;
  differenceHash: bigint;
  histogram: number[];
}

export interface ImageCandidate {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string;
  imageBuffer: Buffer;
}

export interface ImageMatchScore {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string;
  confidence: number;
  averageHashSimilarity: number;
  differenceHashSimilarity: number;
  colorSimilarity: number;
}

export interface ImageDiagnostics {
  width: number | null;
  height: number | null;
  format: string | null;
  sizeBytes: number;
  isUsable: boolean;
  reason?: string;
}

export const PERCEPTUAL_MATCH_THRESHOLD = 0.65;

export async function fingerprintImage(buffer: Buffer): Promise<ImageFingerprint> {
  const diagnostics = await inspectImageBuffer(buffer);
  if (!diagnostics.isUsable) {
    throw new Error(`Image is not usable for matching: ${diagnostics.reason ?? 'unknown'}`);
  }

  const averagePixels = await normalizedSharp(buffer)
    .resize(8, 8, { fit: 'contain', background: HASH_BACKGROUND, kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer();

  const differencePixels = await normalizedSharp(buffer)
    .resize(9, 8, { fit: 'contain', background: HASH_BACKGROUND, kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer();

  const colorPixels = await normalizedSharp(buffer)
    .resize(32, 32, { fit: 'contain', background: HASH_BACKGROUND, kernel: 'lanczos3' })
    .raw()
    .toBuffer();

  return {
    averageHash: averageHash(averagePixels),
    differenceHash: differenceHash(differencePixels),
    histogram: colorHistogram(colorPixels),
  };
}

export async function inspectImageBuffer(buffer: Buffer): Promise<ImageDiagnostics> {
  try {
    const image = normalizedSharp(buffer);
    const metadata = await image.metadata();
    const width = metadata.width ?? null;
    const height = metadata.height ?? null;
    if (!width || !height) {
      return { width, height, format: metadata.format ?? null, sizeBytes: buffer.length, isUsable: false, reason: 'missing_dimensions' };
    }
    if (width < MIN_USABLE_DIMENSION_PX || height < MIN_USABLE_DIMENSION_PX) {
      return { width, height, format: metadata.format ?? null, sizeBytes: buffer.length, isUsable: false, reason: 'too_small' };
    }

    const stats = await normalizedSharp(buffer).resize(32, 32, { fit: 'contain', background: HASH_BACKGROUND }).stats();
    const meanStdev =
      stats.channels.slice(0, 3).reduce((sum, channel) => sum + (channel.stdev ?? 0), 0) /
      Math.max(stats.channels.slice(0, 3).length, 1);
    if (meanStdev < 1) {
      return { width, height, format: metadata.format ?? null, sizeBytes: buffer.length, isUsable: false, reason: 'blank_image' };
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
      const averageHashSimilarity =
        1 - hammingDistance(query.averageHash, candidateFingerprint.averageHash) / 64;
      const differenceHashSimilarity =
        1 - hammingDistance(query.differenceHash, candidateFingerprint.differenceHash) / 64;
      const colorSimilarity = cosineSimilarity(query.histogram, candidateFingerprint.histogram);
      const confidence =
        0.4 * averageHashSimilarity + 0.4 * differenceHashSimilarity + 0.2 * colorSimilarity;

      scores.push({
        productId: candidate.productId,
        sku: candidate.sku,
        name: candidate.name,
        imageUrl: candidate.imageUrl,
        confidence: roundConfidence(confidence),
        averageHashSimilarity: roundConfidence(averageHashSimilarity),
        differenceHashSimilarity: roundConfidence(differenceHashSimilarity),
        colorSimilarity: roundConfidence(colorSimilarity),
      });
    } catch {
      // One corrupt catalog image should not fail the whole matching run.
    }
  }

  return distinctBestProductScores(scores);
}

function normalizedSharp(buffer: Buffer): sharp.Sharp {
  // Keep the full garment visible: normalize EXIF orientation, flatten alpha to white,
  // convert to RGB, and use contain-padding in downstream resizes instead of stretch/crop.
  return sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: HASH_BACKGROUND })
    .toColourspace('srgb');
}

function distinctBestProductScores(scores: ImageMatchScore[]): ImageMatchScore[] {
  const bestByProduct = new Map<string, ImageMatchScore>();
  for (const score of scores) {
    const existing = bestByProduct.get(score.productId);
    if (!existing || score.confidence > existing.confidence) {
      bestByProduct.set(score.productId, score);
    }
  }
  return [...bestByProduct.values()].sort((a, b) => b.confidence - a.confidence);
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

function hammingDistance(a: bigint, b: bigint): number {
  let value = a ^ b;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
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
  return dot / (Math.sqrt(aNorm) * Math.sqrt(bNorm));
}

function roundConfidence(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * 1000) / 1000));
}
