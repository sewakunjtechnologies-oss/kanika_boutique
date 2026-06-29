import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { env } from '../config/env';

const HASH_BACKGROUND = { r: 255, g: 255, b: 255, alpha: 1 };
const MIN_USABLE_DIMENSION_PX = 24;
const PIXEL_VIEW_SIZE = 64;
const DESCRIPTOR_VIEW_SIZE = 64;
const PHASH_SIZE = 32;
const HASH_BITS = 64;
const MAX_FINGERPRINT_CACHE_ENTRIES = 512;

export const IMAGE_MATCH_ALGORITHM_VERSION = 'garment-local-v4';
export const IMAGE_MATCH_FEATURE_SCHEMA_VERSION = 4;
export const PERCEPTUAL_MATCH_THRESHOLD = 0.65;

export type ImageMatchType =
  | 'EXACT_MATCH'
  | 'NEAR_DUPLICATE_MATCH'
  | 'LOCAL_FEATURE_MATCH'
  | 'GARMENT_EMBEDDING_MATCH'
  | 'GENERAL_MATCH';
export type ImageViewKind =
  | 'full'
  | 'crop'
  | 'stretch'
  | 'trim'
  | 'screenshotClean'
  | 'garment'
  | 'upperGarment'
  | 'lowerGarment'
  | 'texture';

const IMAGE_VIEW_KINDS: ImageViewKind[] = [
  'full',
  'crop',
  'stretch',
  'trim',
  'screenshotClean',
  'garment',
  'upperGarment',
  'lowerGarment',
  'texture',
];

const GARMENT_VIEW_KINDS: ImageViewKind[] = [
  'garment',
  'upperGarment',
  'lowerGarment',
  'texture',
];

const GARMENT_EMBEDDING_VIEW_KINDS: ImageViewKind[] = [
  'garment',
  'upperGarment',
  'lowerGarment',
  'texture',
  'screenshotClean',
];

export interface ImageViewBox {
  kind: ImageViewKind;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  method: string;
}

interface LocalDescriptor {
  x: number;
  y: number;
  energy: number;
  vector: number[];
}

interface ImageFeatureView {
  averageHash: bigint;
  differenceHash: bigint;
  perceptualHash: bigint;
  pixels: Buffer;
  colorPixels: Buffer;
  edges: Float32Array;
  histogram: number[];
  colorSignature: number[];
  patternHistogram: number[];
  linePatternSignature: number[];
  embedding: number[];
  localDescriptors: LocalDescriptor[];
  box: ImageViewBox;
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
  cropBoxes: ImageViewBox[];
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
  garmentColorSimilarity: number;
  embeddingSimilarity: number | null;
  garmentEmbeddingSimilarity: number;
  localFeatureScore: number;
  localFeatureMatches: number;
  localFeatureInlierRatio: number;
  localFeatureCoverage: number;
  patternSimilarity: number;
  linePatternSimilarity: number;
  matchedViewPair: string | null;
  cropBoxes: ImageViewBox[];
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

export async function writeImageMatchDebugViews(
  buffer: Buffer,
  outputDir: string,
  prefix = 'query',
): Promise<Record<ImageViewKind, string>> {
  const diagnostics = await inspectImageBuffer(buffer);
  if (!diagnostics.isUsable || diagnostics.width === null || diagnostics.height === null) {
    throw new Error(`Image is not usable for debug views: ${diagnostics.reason ?? 'unknown'}`);
  }

  const safePrefix = prefix.replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '') || 'query';
  await fs.mkdir(outputDir, { recursive: true });
  const viewSources = await buildViewSources(buffer, diagnostics.width, diagnostics.height);
  const paths = {} as Record<ImageViewKind, string>;
  for (const kind of IMAGE_VIEW_KINDS) {
    const filePath = path.join(outputDir, `${safePrefix}-${kind}.jpg`);
    const jpeg = await sharp(viewSources[kind].buffer, { failOn: 'none' }).jpeg({ quality: 90 }).toBuffer();
    await fs.writeFile(filePath, jpeg);
    paths[kind] = filePath;
  }
  return paths;
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
  const garmentColorSimilarity = bestGarmentColorSimilarity(query, candidateFingerprint);
  const localFeature = bestLocalFeatureSimilarity(query, candidateFingerprint);
  const garmentEmbeddingSimilarity = bestEmbeddingSimilarity(query, candidateFingerprint);
  const patternSimilarity = bestPatternSimilarity(query, candidateFingerprint);
  const linePatternSimilarity = bestLinePatternSimilarity(query, candidateFingerprint);
  const rawHashMatch = query.rawSha256 === candidateFingerprint.rawSha256;
  const decodedHashMatch = query.decodedSha256 === candidateFingerprint.decodedSha256;
  const nearDuplicateScore = roundConfidence(
    0.19 * perceptualHashSimilarity +
      0.1 * differenceHashSimilarity +
      0.06 * averageHashSimilarity +
      0.15 * pixelSimilarity +
      0.14 * colorPixelSimilarity +
      0.1 * structuralSimilarity +
      0.1 * edgeSimilarity +
      0.1 * localFeature.score +
      0.03 * patternSimilarity +
      0.03 * linePatternSimilarity +
      0.02 * garmentColorSimilarity,
  );
  const generalScore = roundConfidence(
    0.14 * localFeature.score +
      0.16 * garmentEmbeddingSimilarity +
      0.1 * patternSimilarity +
      0.26 * linePatternSimilarity +
      0.01 * garmentColorSimilarity +
      0.08 * structuralSimilarity +
      0.15 * edgeSimilarity +
      0.08 * perceptualHashSimilarity +
      0.02 * colorPixelSimilarity,
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
  const localFeatureMatch =
    !exactMatch &&
    !nearDuplicateMatch &&
    localFeature.score >= env.IMAGE_LOCAL_FEATURE_THRESHOLD &&
    localFeature.matches >= env.IMAGE_LOCAL_FEATURE_MIN_MATCHES &&
    localFeature.inlierRatio >= env.IMAGE_LOCAL_FEATURE_MIN_INLIER_RATIO &&
    garmentColorSimilarity >= 0.62 &&
    edgeSimilarity >= env.IMAGE_LOCAL_FEATURE_MIN_EDGE_SIMILARITY &&
    linePatternSimilarity >= env.IMAGE_LOCAL_FEATURE_MIN_LINE_PATTERN_SIMILARITY;
  const garmentEmbeddingMatch =
    !exactMatch &&
    !nearDuplicateMatch &&
    !localFeatureMatch &&
    garmentEmbeddingSimilarity >= env.IMAGE_GARMENT_EMBEDDING_THRESHOLD &&
    localFeature.score >= env.IMAGE_LOCAL_FEATURE_THRESHOLD * 0.72 &&
    patternSimilarity >= 0.68 &&
    edgeSimilarity >= env.IMAGE_GARMENT_EMBEDDING_MIN_EDGE_SIMILARITY &&
    linePatternSimilarity >= env.IMAGE_GARMENT_EMBEDDING_MIN_LINE_PATTERN_SIMILARITY;

  const matchType: ImageMatchType = exactMatch
    ? 'EXACT_MATCH'
    : nearDuplicateMatch
      ? 'NEAR_DUPLICATE_MATCH'
      : localFeatureMatch
        ? 'LOCAL_FEATURE_MATCH'
        : garmentEmbeddingMatch
          ? 'GARMENT_EMBEDDING_MATCH'
          : 'GENERAL_MATCH';
  const confidence = exactMatch
    ? 1
    : matchType === 'NEAR_DUPLICATE_MATCH'
      ? nearDuplicateScore
      : matchType === 'LOCAL_FEATURE_MATCH'
        ? Math.max(
            generalScore,
            roundConfidence(
              0.52 * localFeature.score +
                0.18 * patternSimilarity +
                0.15 * linePatternSimilarity +
                0.15 * garmentEmbeddingSimilarity,
            ),
          )
        : matchType === 'GARMENT_EMBEDDING_MATCH'
          ? Math.max(generalScore, roundConfidence(0.43 * garmentEmbeddingSimilarity + 0.24 * localFeature.score + 0.18 * patternSimilarity + 0.15 * linePatternSimilarity))
          : generalScore;

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
    garmentColorSimilarity: roundConfidence(garmentColorSimilarity),
    embeddingSimilarity: roundConfidence(garmentEmbeddingSimilarity),
    garmentEmbeddingSimilarity: roundConfidence(garmentEmbeddingSimilarity),
    localFeatureScore: roundConfidence(localFeature.score),
    localFeatureMatches: localFeature.matches,
    localFeatureInlierRatio: roundConfidence(localFeature.inlierRatio),
    localFeatureCoverage: roundConfidence(localFeature.coverage),
    patternSimilarity: roundConfidence(patternSimilarity),
    linePatternSimilarity: roundConfidence(linePatternSimilarity),
    matchedViewPair: localFeature.viewPair,
    cropBoxes: query.cropBoxes,
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
  const viewSources = await buildViewSources(buffer, decoded.width, decoded.height);
  const views = {} as Record<ImageViewKind, ImageFeatureView>;
  for (const kind of IMAGE_VIEW_KINDS) {
    const source = viewSources[kind];
    views[kind] = await buildFeatureView(source.buffer, kind, source.box);
  }
  const full = views.full;

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
    views,
    cropBoxes: IMAGE_VIEW_KINDS.map((kind) => views[kind].box),
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

interface ViewSource {
  buffer: Buffer;
  box: ImageViewBox;
}

async function buildViewSources(
  buffer: Buffer,
  width: number,
  height: number,
): Promise<Record<ImageViewKind, ViewSource>> {
  const full = viewSource(buffer, viewBox('full', 0, 0, width, height, 1, 'full_frame'), width, height);
  const cleanedBuffer = await suppressScreenshotOverlays(buffer, width, height);
  const screenshotBox = screenshotCleanBox(width, height);
  const screenshotClean = await extractedViewSource(cleanedBuffer, screenshotBox, width, height);
  const garmentBox = await detectGarmentBox(cleanedBuffer, screenshotBox, width, height);
  const garment = await extractedViewSource(cleanedBuffer, garmentBox, width, height);
  const upperGarment = await extractedViewSource(cleanedBuffer, splitBox(garmentBox, 'upperGarment', 0, 0.58, 'upper_garment'), width, height);
  const lowerGarment = await extractedViewSource(cleanedBuffer, splitBox(garmentBox, 'lowerGarment', 0.42, 1, 'lower_garment'), width, height);
  const texture = await extractedViewSource(cleanedBuffer, await detectTextureBox(cleanedBuffer, garmentBox, width, height), width, height);

  return {
    full,
    crop: full,
    stretch: full,
    trim: full,
    screenshotClean,
    garment,
    upperGarment,
    lowerGarment,
    texture,
  };
}

async function extractedViewSource(
  buffer: Buffer,
  box: ImageViewBox,
  imageWidth: number,
  imageHeight: number,
): Promise<ViewSource> {
  const safe = clampBox(box, imageWidth, imageHeight);
  const extracted = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .extract({
      left: Math.round(safe.x),
      top: Math.round(safe.y),
      width: Math.round(safe.width),
      height: Math.round(safe.height),
    })
    .jpeg({ quality: 95 })
    .toBuffer();
  return viewSource(extracted, safe, imageWidth, imageHeight);
}

function viewSource(buffer: Buffer, box: ImageViewBox, imageWidth: number, imageHeight: number): ViewSource {
  return { buffer, box: clampBox(box, imageWidth, imageHeight) };
}

async function buildFeatureView(buffer: Buffer, kind: ImageViewKind, box: ImageViewBox): Promise<ImageFeatureView> {
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
  const colorPixelView = await standardSharp(buffer, kind === 'trim')
    .resize(PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE, resize)
    .raw()
    .toBuffer();
  const colorPixels = await standardSharp(buffer, kind === 'trim')
    .resize(32, 32, resize)
    .raw()
    .toBuffer();
  const descriptorPixels = await standardSharp(buffer, kind === 'trim')
    .resize(DESCRIPTOR_VIEW_SIZE, DESCRIPTOR_VIEW_SIZE, { fit: 'cover', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const descriptorGrey = await standardSharp(buffer, kind === 'trim')
    .resize(DESCRIPTOR_VIEW_SIZE, DESCRIPTOR_VIEW_SIZE, { fit: 'cover', kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer();
  const edges = sobelEdges(pixelView, PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE);
  const patternHistogram = orientationHistogram(pixelView, PIXEL_VIEW_SIZE, PIXEL_VIEW_SIZE);
  const linePatternSignature = linePatternSignatureFromPixels(descriptorPixels, descriptorGrey, DESCRIPTOR_VIEW_SIZE, DESCRIPTOR_VIEW_SIZE);
  const localDescriptors = localTextureDescriptors(
    descriptorPixels,
    descriptorGrey,
    DESCRIPTOR_VIEW_SIZE,
    DESCRIPTOR_VIEW_SIZE,
  );
  const histogram = colorHistogram(colorPixels);
  const colorSignature = garmentColorSignature(colorPixels);

  return {
    averageHash: averageHash(averagePixels),
    differenceHash: differenceHash(differencePixels),
    perceptualHash: perceptualHash(perceptualPixels),
    pixels: pixelView,
    colorPixels: colorPixelView,
    edges,
    histogram,
    colorSignature,
    patternHistogram,
    linePatternSignature,
    embedding: garmentEmbedding(histogram, colorSignature, patternHistogram, linePatternSignature, localDescriptors),
    localDescriptors,
    box,
  };
}

function normalizedSharp(buffer: Buffer, trim = false): sharp.Sharp {
  return standardSharp(buffer, trim).normalise();
}

function standardSharp(buffer: Buffer, trim = false): sharp.Sharp {
  let image = sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: HASH_BACKGROUND })
    .toColourspace('srgb');
  if (trim) {
    image = image.trim({ background: HASH_BACKGROUND, threshold: 24 });
  }
  return image;
}

function viewResizeOptions(kind: ImageViewKind): sharp.ResizeOptions {
  if (kind === 'crop') return { fit: 'cover', kernel: 'lanczos3', position: 'centre' };
  if (kind === 'stretch') return { fit: 'fill', kernel: 'lanczos3' };
  if (kind === 'texture') return { fit: 'cover', kernel: 'lanczos3', position: 'attention' };
  return { fit: 'contain', background: HASH_BACKGROUND, kernel: 'lanczos3' };
}

async function suppressScreenshotOverlays(buffer: Buffer, width: number, height: number): Promise<Buffer> {
  const { data, info } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .flatten({ background: HASH_BACKGROUND })
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(info.width * info.height);
  markCentralDarkOverlays(data, mask, info.width, info.height);
  markWhiteTextOverlays(data, mask, info.width, info.height);
  if (!mask.some((value) => value > 0)) return buffer;
  inpaintMaskedPixels(data, mask, info.width, info.height);
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .jpeg({ quality: 95 })
    .toBuffer();
}

function markCentralDarkOverlays(
  pixels: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
): void {
  const portrait = height / Math.max(width, 1) > 1.25;
  if (!portrait) return;
  const components = connectedPixelComponents(width, height, (x, y) => {
    if (x < width * 0.32 || x > width * 0.68 || y < height * 0.3 || y > height * 0.58) return false;
    const i = (y * width + x) * 3;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const luma = 0.299 * r + 0.587 * g + 0.114 * b;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    return luma < 100 && chroma < 45;
  });
  for (const component of components) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    if (component.count < 140 || boxWidth < 14 || boxHeight < 14) continue;
    fillMaskRect(mask, width, height, component.minX - 6, component.minY - 6, boxWidth + 12, boxHeight + 12);
  }
}

function markWhiteTextOverlays(
  pixels: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
): void {
  const components = connectedPixelComponents(width, height, (x, y) => {
    if (y < height * 0.35 || y > height * 0.82 || x < width * 0.12 || x > width * 0.86) return false;
    const i = (y * width + x) * 3;
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    return r > 232 && g > 232 && b > 232;
  });
  for (const component of components) {
    const boxWidth = component.maxX - component.minX + 1;
    const boxHeight = component.maxY - component.minY + 1;
    const rectangularity = component.count / Math.max(boxWidth * boxHeight, 1);
    if (component.count < 220 || boxWidth < width * 0.12 || boxHeight < height * 0.018) continue;
    if (rectangularity < 0.38) continue;
    fillMaskRect(mask, width, height, component.minX - 8, component.minY - 6, boxWidth + 16, boxHeight + 12);
  }
}

interface PixelComponent {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  count: number;
}

function connectedPixelComponents(
  width: number,
  height: number,
  predicate: (x: number, y: number) => boolean,
): PixelComponent[] {
  const visited = new Uint8Array(width * height);
  const components: PixelComponent[] = [];
  for (let start = 0; start < width * height; start += 1) {
    if (visited[start]) continue;
    const sx = start % width;
    const sy = Math.floor(start / width);
    if (!predicate(sx, sy)) {
      visited[start] = 1;
      continue;
    }
    const stack = [start];
    visited[start] = 1;
    let minX = sx;
    let minY = sy;
    let maxX = sx;
    let maxY = sy;
    let count = 0;
    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = Math.floor(i / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count += 1;
      for (const next of [i - 1, i + 1, i - width, i + width]) {
        if (next < 0 || next >= width * height || visited[next]) continue;
        const nx = next % width;
        if ((next === i - 1 || next === i + 1) && Math.abs(nx - x) !== 1) continue;
        const ny = Math.floor(next / width);
        if (!predicate(nx, ny)) {
          visited[next] = 1;
          continue;
        }
        visited[next] = 1;
        stack.push(next);
      }
    }
    components.push({ minX, minY, maxX, maxY, count });
  }
  return components;
}

function fillMaskRect(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
): void {
  const left = Math.max(0, Math.round(x));
  const top = Math.max(0, Math.round(y));
  const right = Math.min(width, Math.round(x + rectWidth));
  const bottom = Math.min(height, Math.round(y + rectHeight));
  for (let yy = top; yy < bottom; yy += 1) {
    for (let xx = left; xx < right; xx += 1) {
      mask[yy * width + xx] = 1;
    }
  }
}

function inpaintMaskedPixels(
  pixels: Buffer,
  mask: Uint8Array,
  width: number,
  height: number,
): void {
  const integral = buildIntegralImage(pixels, width, height);
  const radius = Math.max(10, Math.round(Math.min(width, height) * 0.035));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const color = averageColorInWindow(integral, width, height, x, y, radius);
      const i = (y * width + x) * 3;
      pixels[i] = color.r;
      pixels[i + 1] = color.g;
      pixels[i + 2] = color.b;
    }
  }
}

function buildIntegralImage(
  pixels: Buffer,
  width: number,
  height: number,
): { r: Float64Array; g: Float64Array; b: Float64Array } {
  const size = (width + 1) * (height + 1);
  const r = new Float64Array(size);
  const g = new Float64Array(size);
  const b = new Float64Array(size);
  for (let y = 1; y <= height; y += 1) {
    for (let x = 1; x <= width; x += 1) {
      const src = ((y - 1) * width + (x - 1)) * 3;
      const dst = y * (width + 1) + x;
      const left = y * (width + 1) + x - 1;
      const top = (y - 1) * (width + 1) + x;
      const topLeft = (y - 1) * (width + 1) + x - 1;
      r[dst] = (pixels[src] ?? 0) + r[left]! + r[top]! - r[topLeft]!;
      g[dst] = (pixels[src + 1] ?? 0) + g[left]! + g[top]! - g[topLeft]!;
      b[dst] = (pixels[src + 2] ?? 0) + b[left]! + b[top]! - b[topLeft]!;
    }
  }
  return { r, g, b };
}

function averageColorInWindow(
  integral: { r: Float64Array; g: Float64Array; b: Float64Array },
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): { r: number; g: number; b: number } {
  const left = Math.max(0, x - radius);
  const top = Math.max(0, y - radius);
  const right = Math.min(width - 1, x + radius);
  const bottom = Math.min(height - 1, y + radius);
  const area = Math.max(1, (right - left + 1) * (bottom - top + 1));
  const sum = (channel: Float64Array): number => {
    const stride = width + 1;
    const a = top * stride + left;
    const bb = top * stride + right + 1;
    const c = (bottom + 1) * stride + left;
    const d = (bottom + 1) * stride + right + 1;
    return channel[d]! - channel[bb]! - channel[c]! + channel[a]!;
  };
  return {
    r: Math.round(sum(integral.r) / area),
    g: Math.round(sum(integral.g) / area),
    b: Math.round(sum(integral.b) / area),
  };
}

function screenshotCleanBox(width: number, height: number): ImageViewBox {
  const portrait = height / Math.max(width, 1) > 1.25;
  const left = portrait ? width * 0.02 : 0;
  const top = portrait ? height * 0.055 : height * 0.02;
  const rightCut = portrait ? width * 0.105 : width * 0.02;
  const bottomCut = portrait ? height * 0.115 : height * 0.04;
  return viewBox(
    'screenshotClean',
    left,
    top,
    width - left - rightCut,
    height - top - bottomCut,
    portrait ? 0.78 : 0.55,
    'screenshot_ui_crop',
  );
}

async function detectGarmentBox(
  buffer: Buffer,
  searchBox: ImageViewBox,
  imageWidth: number,
  imageHeight: number,
): Promise<ImageViewBox> {
  const safeSearch = clampBox(searchBox, imageWidth, imageHeight);
  const sampleWidth = 96;
  const sampleHeight = Math.max(96, Math.round((safeSearch.height / safeSearch.width) * sampleWidth));
  const { data } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .extract({
      left: Math.round(safeSearch.x),
      top: Math.round(safeSearch.y),
      width: Math.round(safeSearch.width),
      height: Math.round(safeSearch.height),
    })
    .resize(sampleWidth, sampleHeight, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const grey = rgbToGrey(data);
  const edges = sobelEdges(grey, sampleWidth, sampleHeight);
  const background = estimateBackgroundColor(data, sampleWidth, sampleHeight);
  const scores = new Float32Array(sampleWidth * sampleHeight);
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const i = y * sampleWidth + x;
      const r = data[i * 3] ?? 0;
      const g = data[i * 3 + 1] ?? 0;
      const b = data[i * 3 + 2] ?? 0;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const colorDistance = Math.sqrt(
        (r - background.r) ** 2 +
          (g - background.g) ** 2 +
          (b - background.b) ** 2,
      ) / 441.7;
      const cx = Math.abs(x / sampleWidth - 0.48);
      const cy = Math.abs(y / sampleHeight - 0.54);
      const centerWeight = Math.max(0, 1 - (cx * 1.55 + cy * 0.8));
      const topPenalty = y < sampleHeight * 0.1 ? 0.5 : 1;
      const score =
        ((edges[i] ?? 0) / 255) * 0.32 +
        saturation * 0.2 +
        colorDistance * 0.34 +
        centerWeight * 0.14;
      scores[i] = score * topPenalty;
    }
  }

  const threshold = Math.max(percentile(Array.from(scores), 0.84), 0.25);
  const component = largestSalientComponent(scores, sampleWidth, sampleHeight, threshold);
  let { minX, minY, maxX, maxY, hitCount } = component;
  for (let y = 0; y < sampleHeight; y += 1) {
    for (let x = 0; x < sampleWidth; x += 1) {
      const i = y * sampleWidth + x;
      const score = scores[i] ?? 0;
      if (hitCount > 0 || score < threshold * 1.08) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      hitCount += 1;
    }
  }

  if (hitCount < sampleWidth * sampleHeight * 0.025) {
    return viewBox(
      'garment',
      safeSearch.x + safeSearch.width * 0.08,
      safeSearch.y + safeSearch.height * 0.08,
      safeSearch.width * 0.78,
      safeSearch.height * 0.78,
      0.35,
      'center_fallback',
    );
  }

  const padX = sampleWidth * 0.1;
  const padY = sampleHeight * 0.06;
  const scaleX = safeSearch.width / sampleWidth;
  const scaleY = safeSearch.height / sampleHeight;
  const sampleLeft = Math.max(0, minX - padX);
  let sampleTop = Math.max(0, minY - padY);
  const sampleRight = Math.min(sampleWidth, maxX + padX);
  let sampleBottom = Math.min(sampleHeight, maxY + padY);
  const startsLow = sampleTop > sampleHeight * 0.3;
  const portraitLike = imageHeight / Math.max(imageWidth, 1) > 1.25;
  if (startsLow && portraitLike) {
    return portraitCenterProductBox(safeSearch);
  }
  return viewBox(
    'garment',
    safeSearch.x + sampleLeft * scaleX,
    safeSearch.y + sampleTop * scaleY,
    sampleRight * scaleX - sampleLeft * scaleX,
    sampleBottom * scaleY - sampleTop * scaleY,
    Math.min(0.9, 0.45 + hitCount / (sampleWidth * sampleHeight)),
    'edge_saliency',
  );
}

function portraitCenterProductBox(searchBox: ImageViewBox): ImageViewBox {
  return viewBox(
    'garment',
    searchBox.x + searchBox.width * 0.08,
    searchBox.y + searchBox.height * 0.06,
    searchBox.width * 0.78,
    searchBox.height * 0.78,
    0.5,
    'portrait_center_product_fallback',
  );
}

async function detectTextureBox(
  buffer: Buffer,
  garmentBox: ImageViewBox,
  imageWidth: number,
  imageHeight: number,
): Promise<ImageViewBox> {
  const safe = clampBox(garmentBox, imageWidth, imageHeight);
  const sampleWidth = 96;
  const sampleHeight = 96;
  const { data } = await sharp(buffer, { failOn: 'none' })
    .rotate()
    .extract({
      left: Math.round(safe.x),
      top: Math.round(safe.y),
      width: Math.round(safe.width),
      height: Math.round(safe.height),
    })
    .resize(sampleWidth, sampleHeight, { fit: 'fill', kernel: 'lanczos3' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const edges = sobelEdges(data, sampleWidth, sampleHeight);
  const window = 32;
  const stride = 16;
  let best = { x: sampleWidth * 0.25, y: sampleHeight * 0.25, energy: -1 };
  for (let y = 0; y <= sampleHeight - window; y += stride) {
    for (let x = 0; x <= sampleWidth - window; x += stride) {
      let energy = 0;
      for (let yy = y; yy < y + window; yy += 1) {
        for (let xx = x; xx < x + window; xx += 1) {
          energy += edges[yy * sampleWidth + xx] ?? 0;
        }
      }
      if (energy > best.energy) best = { x, y, energy };
    }
  }
  return viewBox(
    'texture',
    safe.x + (best.x / sampleWidth) * safe.width,
    safe.y + (best.y / sampleHeight) * safe.height,
    (window / sampleWidth) * safe.width,
    (window / sampleHeight) * safe.height,
    best.energy > 0 ? 0.72 : 0.35,
    'max_edge_texture_window',
  );
}

function splitBox(
  box: ImageViewBox,
  kind: ImageViewKind,
  startRatio: number,
  endRatio: number,
  method: string,
): ImageViewBox {
  return viewBox(
    kind,
    box.x,
    box.y + box.height * startRatio,
    box.width,
    box.height * (endRatio - startRatio),
    box.confidence,
    method,
  );
}

function viewBox(
  kind: ImageViewKind,
  x: number,
  y: number,
  width: number,
  height: number,
  confidence: number,
  method: string,
): ImageViewBox {
  return { kind, x, y, width, height, confidence, method };
}

function clampBox(box: ImageViewBox, imageWidth: number, imageHeight: number): ImageViewBox {
  const x = Math.max(0, Math.min(Math.round(box.x), Math.max(0, imageWidth - 1)));
  const y = Math.max(0, Math.min(Math.round(box.y), Math.max(0, imageHeight - 1)));
  const width = Math.max(1, Math.min(Math.round(box.width), imageWidth - x));
  const height = Math.max(1, Math.min(Math.round(box.height), imageHeight - y));
  return { ...box, x, y, width, height };
}

function estimateBackgroundColor(
  pixels: Buffer,
  width: number,
  height: number,
): { r: number; g: number; b: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const borderX = Math.max(2, Math.round(width * 0.08));
  const borderY = Math.max(2, Math.round(height * 0.08));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (x > borderX && x < width - borderX && y > borderY && y < height - borderY) continue;
      const i = (y * width + x) * 3;
      r += pixels[i] ?? 0;
      g += pixels[i + 1] ?? 0;
      b += pixels[i + 2] ?? 0;
      count += 1;
    }
  }
  return {
    r: count ? r / count : 255,
    g: count ? g / count : 255,
    b: count ? b / count : 255,
  };
}

function largestSalientComponent(
  scores: Float32Array,
  width: number,
  height: number,
  threshold: number,
): { minX: number; minY: number; maxX: number; maxY: number; hitCount: number } {
  const visited = new Uint8Array(width * height);
  let best = { minX: width, minY: height, maxX: 0, maxY: 0, hitCount: 0, weightedSize: 0 };

  for (let start = 0; start < scores.length; start += 1) {
    if (visited[start] || (scores[start] ?? 0) < threshold) continue;
    const stack = [start];
    visited[start] = 1;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    let hitCount = 0;
    let weightedSize = 0;

    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = Math.floor(i / width);
      const centerWeight = Math.max(0.2, 1 - Math.abs(x / width - 0.5) * 0.9);
      weightedSize += centerWeight;
      hitCount += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (const next of [i - 1, i + 1, i - width, i + width]) {
        if (next < 0 || next >= scores.length || visited[next]) continue;
        const nx = next % width;
        if ((next === i - 1 || next === i + 1) && Math.abs(nx - x) !== 1) continue;
        if ((scores[next] ?? 0) < threshold) continue;
        visited[next] = 1;
        stack.push(next);
      }
    }

    if (weightedSize > best.weightedSize) {
      best = { minX, minY, maxX, maxY, hitCount, weightedSize };
    }
  }

  return {
    minX: best.minX,
    minY: best.minY,
    maxX: best.maxX,
    maxY: best.maxY,
    hitCount: best.hitCount,
  };
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
  const confidenceDiff = b.confidence - a.confidence;
  if (confidenceDiff !== 0) return confidenceDiff;
  const exactDiff = Number(b.rawHashMatch || b.decodedHashMatch) - Number(a.rawHashMatch || a.decodedHashMatch);
  if (exactDiff !== 0) return exactDiff;
  return (
    b.nearDuplicateScore - a.nearDuplicateScore ||
    b.pixelSimilarity - a.pixelSimilarity ||
    b.colorPixelSimilarity - a.colorPixelSimilarity ||
    b.structuralSimilarity - a.structuralSimilarity ||
    b.edgeSimilarity - a.edgeSimilarity ||
    b.perceptualHashSimilarity - a.perceptualHashSimilarity ||
    b.localFeatureScore - a.localFeatureScore ||
    b.garmentEmbeddingSimilarity - a.garmentEmbeddingSimilarity ||
    b.garmentColorSimilarity - a.garmentColorSimilarity
  );
}

function matchPriority(matchType: ImageMatchType): number {
  if (matchType === 'EXACT_MATCH') return 3;
  if (matchType === 'NEAR_DUPLICATE_MATCH') return 2;
  if (matchType === 'LOCAL_FEATURE_MATCH') return 1.8;
  if (matchType === 'GARMENT_EMBEDDING_MATCH') return 1.6;
  return 1;
}

function bestHashSimilarity(
  a: ImageFingerprint,
  b: ImageFingerprint,
  key: 'averageHash' | 'differenceHash' | 'perceptualHash',
): number {
  const pairs = comparableViewPairs();
  return Math.max(
    ...pairs.map(([left, right]) => 1 - hammingDistance(a.views[left][key], b.views[right][key]) / HASH_BITS),
  );
}

function bestViewSimilarity(
  a: ImageFingerprint,
  b: ImageFingerprint,
  metric: (left: Buffer, right: Buffer) => number,
): number {
  return Math.max(...comparableViewPairs().map(([left, right]) => metric(a.views[left].pixels, b.views[right].pixels)));
}

function bestColorViewSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(...comparableViewPairs().map(([left, right]) => (
    normalizedPixelSimilarity(a.views[left].colorPixels, b.views[right].colorPixels)
  )));
}

function bestEdgeSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(...comparableViewPairs().map(([left, right]) => (
    cosineSimilarity(Array.from(a.views[left].edges), Array.from(b.views[right].edges))
  )));
}

function comparableViewPairs(): Array<[ImageViewKind, ImageViewKind]> {
  return [
    ['full', 'full'],
    ['crop', 'crop'],
    ['stretch', 'stretch'],
    ['trim', 'trim'],
    ['screenshotClean', 'screenshotClean'],
    ['garment', 'garment'],
    ['upperGarment', 'upperGarment'],
    ['lowerGarment', 'lowerGarment'],
    ['texture', 'texture'],
    ['screenshotClean', 'garment'],
    ['garment', 'screenshotClean'],
    ['garment', 'upperGarment'],
    ['upperGarment', 'garment'],
    ['garment', 'lowerGarment'],
    ['lowerGarment', 'garment'],
    ['full', 'crop'],
    ['crop', 'full'],
    ['full', 'trim'],
    ['trim', 'full'],
  ];
}

function bestColorSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  return Math.max(
    cosineSimilarity(a.views.full.histogram, b.views.full.histogram),
    cosineSimilarity(a.views.crop.histogram, b.views.crop.histogram),
    cosineSimilarity(a.views.trim.histogram, b.views.trim.histogram),
    cosineSimilarity(a.views.screenshotClean.histogram, b.views.screenshotClean.histogram),
    cosineSimilarity(a.views.garment.histogram, b.views.garment.histogram),
    cosineSimilarity(a.views.upperGarment.histogram, b.views.upperGarment.histogram),
    cosineSimilarity(a.views.lowerGarment.histogram, b.views.lowerGarment.histogram),
  );
}

function bestGarmentColorSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  let best = 0;
  for (const left of GARMENT_EMBEDDING_VIEW_KINDS) {
    for (const right of GARMENT_EMBEDDING_VIEW_KINDS) {
      best = Math.max(best, histogramIntersection(a.views[left].colorSignature, b.views[right].colorSignature));
    }
  }
  return best;
}

function bestEmbeddingSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  let best = 0;
  for (const left of GARMENT_EMBEDDING_VIEW_KINDS) {
    for (const right of GARMENT_EMBEDDING_VIEW_KINDS) {
      best = Math.max(best, cosineSimilarity(a.views[left].embedding, b.views[right].embedding));
    }
  }
  return best;
}

function bestPatternSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  let best = 0;
  for (const left of GARMENT_EMBEDDING_VIEW_KINDS) {
    for (const right of GARMENT_EMBEDDING_VIEW_KINDS) {
      best = Math.max(best, cosineSimilarity(a.views[left].patternHistogram, b.views[right].patternHistogram));
    }
  }
  return best;
}

function bestLinePatternSimilarity(a: ImageFingerprint, b: ImageFingerprint): number {
  let best = 0;
  for (const left of GARMENT_EMBEDDING_VIEW_KINDS) {
    for (const right of GARMENT_EMBEDDING_VIEW_KINDS) {
      best = Math.max(best, linePatternSimilarity(a.views[left].linePatternSignature, b.views[right].linePatternSignature));
    }
  }
  return best;
}

interface LocalFeatureResult {
  score: number;
  matches: number;
  inlierRatio: number;
  coverage: number;
  viewPair: string | null;
}

function bestLocalFeatureSimilarity(a: ImageFingerprint, b: ImageFingerprint): LocalFeatureResult {
  let best: LocalFeatureResult = { score: 0, matches: 0, inlierRatio: 0, coverage: 0, viewPair: null };
  for (const left of GARMENT_VIEW_KINDS) {
    for (const right of GARMENT_VIEW_KINDS) {
      const result = localFeatureSimilarity(a.views[left].localDescriptors, b.views[right].localDescriptors);
      if (result.score > best.score) {
        best = { ...result, viewPair: `${left}:${right}` };
      }
    }
  }
  return best;
}

function localFeatureSimilarity(
  queryDescriptors: LocalDescriptor[],
  candidateDescriptors: LocalDescriptor[],
): Omit<LocalFeatureResult, 'viewPair'> {
  const query = queryDescriptors.slice(0, 90);
  const candidate = candidateDescriptors.slice(0, 120);
  if (query.length === 0 || candidate.length === 0) {
    return { score: 0, matches: 0, inlierRatio: 0, coverage: 0 };
  }

  let matches = 0;
  let similaritySum = 0;
  const coveredCells = new Set<string>();
  for (const descriptor of query) {
    let best = -1;
    let second = -1;
    for (const other of candidate) {
      const sim = cosineSimilarity(descriptor.vector, other.vector);
      if (sim > best) {
        second = best;
        best = sim;
      } else if (sim > second) {
        second = sim;
      }
    }
    if (best >= 0.915 && best - Math.max(second, 0) >= 0.012) {
      matches += 1;
      similaritySum += best;
      coveredCells.add(`${Math.floor(descriptor.x * 4)}:${Math.floor(descriptor.y * 4)}`);
    }
  }

  const inlierRatio = matches / Math.max(query.length, 1);
  const coverage = Math.min(1, coveredCells.size / 8);
  const avgSimilarity = matches > 0 ? similaritySum / matches : 0;
  const matchDensity = Math.min(1, matches / Math.max(18, Math.min(query.length, candidate.length) * 0.42));
  const score = clamp01(0.42 * matchDensity + 0.31 * avgSimilarity + 0.17 * coverage + 0.1 * inlierRatio);
  return {
    score,
    matches,
    inlierRatio,
    coverage,
  };
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

function orientationHistogram(pixels: Buffer, width: number, height: number): number[] {
  const bins = new Array<number>(12).fill(0);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
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
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude < 18) continue;
      const angle = (Math.atan2(gy, gx) + Math.PI) / (2 * Math.PI);
      const bin = Math.min(bins.length - 1, Math.floor(angle * bins.length));
      bins[bin] = (bins[bin] ?? 0) + magnitude;
    }
  }
  return normalizeVector(bins);
}

function linePatternSignatureFromPixels(
  colorPixels: Buffer,
  greyPixels: Buffer,
  width: number,
  height: number,
): number[] {
  let verticalMass = 0;
  let horizontalMass = 0;
  let diagonalMass = 0;
  let edgeMass = 0;
  let edgeCount = 0;
  let blueInk = 0;
  let darkInk = 0;
  let lightInk = 0;
  let saturatedInk = 0;
  const columnEnergy = new Array<number>(width).fill(0);
  const rowEnergy = new Array<number>(height).fill(0);
  const edgeMask = new Uint8Array(width * height);

  for (let i = 0; i + 2 < colorPixels.length; i += 3) {
    const r = colorPixels[i] ?? 0;
    const g = colorPixels[i + 1] ?? 0;
    const b = colorPixels[i + 2] ?? 0;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const saturation = max === 0 ? 0 : chroma / max;
    if (b > 82 && b > r * 1.12 && b > g * 0.98) blueInk += 1;
    if (max < 92) darkInk += 1;
    if (min > 190 && saturation < 0.22) lightInk += 1;
    if (saturation > 0.28) saturatedInk += 1;
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const left = greyPixels[y * width + (x - 1)] ?? 0;
      const right = greyPixels[y * width + (x + 1)] ?? 0;
      const top = greyPixels[(y - 1) * width + x] ?? 0;
      const bottom = greyPixels[(y + 1) * width + x] ?? 0;
      const gx = right - left;
      const gy = bottom - top;
      const absX = Math.abs(gx);
      const absY = Math.abs(gy);
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      if (magnitude < 20) continue;
      edgeMass += magnitude;
      edgeCount += 1;
      columnEnergy[x] = (columnEnergy[x] ?? 0) + absX;
      rowEnergy[y] = (rowEnergy[y] ?? 0) + absY;
      if (Math.max(absX, absY) / Math.max(Math.min(absX, absY), 1) > 2.15) {
        if (absX > absY) verticalMass += magnitude;
        else horizontalMass += magnitude;
      } else {
        diagonalMass += magnitude;
      }
      edgeMask[y * width + x] = 1;
    }
  }

  const verticalRunRatio = longRunRatio(edgeMask, width, height, 'vertical');
  const horizontalRunRatio = longRunRatio(edgeMask, width, height, 'horizontal');
  const columnConcentration = energyConcentration(columnEnergy);
  const rowConcentration = energyConcentration(rowEnergy);
  const totalDirectional = verticalMass + horizontalMass + diagonalMass || 1;
  const totalPixels = Math.max(1, width * height);
  const lineDominance = clamp01((verticalMass + horizontalMass) / totalDirectional);
  const gridRegularity = clamp01((verticalRunRatio + horizontalRunRatio) * 0.7 + (columnConcentration + rowConcentration) * 0.15);

  return [
    verticalMass / totalDirectional,
    horizontalMass / totalDirectional,
    diagonalMass / totalDirectional,
    lineDominance,
    verticalRunRatio,
    horizontalRunRatio,
    columnConcentration,
    rowConcentration,
    clamp01(edgeCount / totalPixels / 0.42),
    gridRegularity,
    blueInk / totalPixels,
    darkInk / totalPixels,
    lightInk / totalPixels,
    saturatedInk / totalPixels,
    clamp01(edgeMass / totalPixels / 42),
  ];
}

function longRunRatio(
  edgeMask: Uint8Array,
  width: number,
  height: number,
  direction: 'vertical' | 'horizontal',
): number {
  let runPixels = 0;
  let edgePixels = 0;
  const outer = direction === 'vertical' ? width : height;
  const inner = direction === 'vertical' ? height : width;
  for (let outerIndex = 0; outerIndex < outer; outerIndex += 1) {
    let run = 0;
    for (let innerIndex = 0; innerIndex < inner; innerIndex += 1) {
      const x = direction === 'vertical' ? outerIndex : innerIndex;
      const y = direction === 'vertical' ? innerIndex : outerIndex;
      const isEdge = edgeMask[y * width + x] === 1;
      if (isEdge) {
        edgePixels += 1;
        run += 1;
        continue;
      }
      if (run >= 5) runPixels += run;
      run = 0;
    }
    if (run >= 5) runPixels += run;
  }
  return clamp01(runPixels / Math.max(edgePixels, 1));
}

function energyConcentration(values: number[]): number {
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
  if (mean <= 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / Math.max(values.length, 1);
  return clamp01(Math.sqrt(variance) / mean / 2.2);
}

function linePatternSimilarity(a: number[], b: number[]): number {
  const weights = [
    0.85,
    0.85,
    0.75,
    1.05,
    1.8,
    1.8,
    0.85,
    0.85,
    0.6,
    1.5,
    2.2,
    1.4,
    0.85,
    0.7,
    0.65,
  ];
  let weightedDiff = 0;
  let totalWeight = 0;
  for (let i = 0; i < Math.min(a.length, b.length, weights.length); i += 1) {
    const weight = weights[i] ?? 1;
    weightedDiff += Math.abs((a[i] ?? 0) - (b[i] ?? 0)) * weight;
    totalWeight += weight;
  }
  return clamp01(1 - (weightedDiff / Math.max(totalWeight, 1)) * 1.7);
}

function localTextureDescriptors(
  colorPixels: Buffer,
  greyPixels: Buffer,
  width: number,
  height: number,
): LocalDescriptor[] {
  const patch = 16;
  const stride = 8;
  const descriptors: LocalDescriptor[] = [];
  for (let y = 0; y <= height - patch; y += stride) {
    for (let x = 0; x <= width - patch; x += stride) {
      let sum = 0;
      let sumSq = 0;
      let edgeEnergy = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      const orientation = new Array<number>(8).fill(0);
      const colorBins = new Array<number>(12).fill(0);
      let count = 0;
      for (let yy = y + 1; yy < y + patch - 1; yy += 1) {
        for (let xx = x + 1; xx < x + patch - 1; xx += 1) {
          const i = yy * width + xx;
          const value = greyPixels[i] ?? 0;
          sum += value;
          sumSq += value * value;
          const left = greyPixels[yy * width + (xx - 1)] ?? 0;
          const right = greyPixels[yy * width + (xx + 1)] ?? 0;
          const top = greyPixels[(yy - 1) * width + xx] ?? 0;
          const bottom = greyPixels[(yy + 1) * width + xx] ?? 0;
          const gx = right - left;
          const gy = bottom - top;
          const magnitude = Math.sqrt(gx * gx + gy * gy);
          edgeEnergy += magnitude;
          if (magnitude > 14) {
            const angle = (Math.atan2(gy, gx) + Math.PI) / (2 * Math.PI);
            const bin = Math.min(orientation.length - 1, Math.floor(angle * orientation.length));
            orientation[bin] = (orientation[bin] ?? 0) + magnitude;
          }
          const ci = i * 3;
          const cr = colorPixels[ci] ?? 0;
          const cg = colorPixels[ci + 1] ?? 0;
          const cb = colorPixels[ci + 2] ?? 0;
          r += cr;
          g += cg;
          b += cb;
          const dominant = cr >= cg && cr >= cb ? 0 : cg >= cr && cg >= cb ? 1 : 2;
          const brightness = Math.min(3, Math.floor(((cr + cg + cb) / 3) / 64));
          colorBins[dominant * 4 + brightness] = (colorBins[dominant * 4 + brightness] ?? 0) + 1;
          count += 1;
        }
      }
      if (count === 0) continue;
      const mean = sum / count;
      const variance = Math.max(0, sumSq / count - mean * mean);
      const stdev = Math.sqrt(variance);
      const energy = edgeEnergy / count + stdev;
      if (energy < 19) continue;
      const vector = normalizeVector([
        (r / count / 255) * 1.45,
        (g / count / 255) * 1.45,
        (b / count / 255) * 1.45,
        mean / 255,
        stdev / 96,
        edgeEnergy / count / 96,
        ...normalizeVector(orientation),
        ...normalizeVector(colorBins).map((value) => value * 1.7),
      ]);
      descriptors.push({
        x: (x + patch / 2) / width,
        y: (y + patch / 2) / height,
        energy,
        vector,
      });
    }
  }
  return descriptors.sort((a, b) => b.energy - a.energy).slice(0, 120);
}

function garmentEmbedding(
  histogram: number[],
  colorSignature: number[],
  patternHistogram: number[],
  linePatternSignature: number[],
  descriptors: LocalDescriptor[],
): number[] {
  const descriptorMean = new Array<number>(descriptors[0]?.vector.length ?? 0).fill(0);
  for (const descriptor of descriptors.slice(0, 60)) {
    for (let i = 0; i < descriptor.vector.length; i += 1) {
      descriptorMean[i] = (descriptorMean[i] ?? 0) + (descriptor.vector[i] ?? 0);
    }
  }
  if (descriptors.length > 0) {
    for (let i = 0; i < descriptorMean.length; i += 1) {
      descriptorMean[i] = (descriptorMean[i] ?? 0) / Math.min(descriptors.length, 60);
    }
  }
  return normalizeVector([
    ...histogram.map((value) => value * 0.55),
    ...colorSignature.map((value) => value * 1.6),
    ...patternHistogram.map((value) => value * 1.35),
    ...linePatternSignature.map((value) => value * 1.65),
    ...descriptorMean.map((value) => value * 1.1),
  ]);
}

function rgbToGrey(pixels: Buffer): Buffer {
  const grey = Buffer.alloc(Math.floor(pixels.length / 3));
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    grey[i / 3] = Math.round((pixels[i] ?? 0) * 0.299 + (pixels[i + 1] ?? 0) * 0.587 + (pixels[i + 2] ?? 0) * 0.114);
  }
  return grey;
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

function garmentColorSignature(pixels: Buffer): number[] {
  const bins = new Array<number>(32).fill(0);
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const r = (pixels[i] ?? 0) / 255;
    const g = (pixels[i + 1] ?? 0) / 255;
    const b = (pixels[i + 2] ?? 0) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const chroma = max - min;
    const value = max;
    const saturation = max === 0 ? 0 : chroma / max;
    if (value < 0.16) {
      bins[24] = (bins[24] ?? 0) + 1;
      continue;
    }
    if (value > 0.84 && saturation < 0.14) {
      bins[25] = (bins[25] ?? 0) + 1;
      continue;
    }
    if (saturation < 0.16) {
      const greyBin = 26 + Math.min(5, Math.floor(value * 6));
      bins[greyBin] = (bins[greyBin] ?? 0) + 1;
      continue;
    }
    let hue = 0;
    if (max === r) hue = ((g - b) / chroma + (g < b ? 6 : 0)) / 6;
    else if (max === g) hue = ((b - r) / chroma + 2) / 6;
    else hue = ((r - g) / chroma + 4) / 6;
    const hueBin = Math.min(23, Math.floor(hue * 24));
    bins[hueBin] = (bins[hueBin] ?? 0) + 1 + saturation;
  }
  const total = bins.reduce((sum, value) => sum + value, 0) || 1;
  return bins.map((count) => count / total);
}

function histogramIntersection(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    sum += Math.min(a[i] ?? 0, b[i] ?? 0);
  }
  return clamp01(sum);
}

function normalizeVector(values: number[]): number[] {
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) return values.map(() => 0);
  return values.map((value) => value / norm);
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

function percentile(values: number[], ratio: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * ratio)))] ?? 0;
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
