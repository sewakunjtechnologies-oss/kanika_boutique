import sharp from 'sharp';

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

export const PERCEPTUAL_MATCH_THRESHOLD = 0.9;

export async function fingerprintImage(buffer: Buffer): Promise<ImageFingerprint> {
  const averagePixels = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(8, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  const differencePixels = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(9, 8, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  const colorPixels = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .resize(32, 32, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();

  return {
    averageHash: averageHash(averagePixels),
    differenceHash: differenceHash(differencePixels),
    histogram: colorHistogram(colorPixels),
  };
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

  return scores.sort((a, b) => b.confidence - a.confidence);
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
