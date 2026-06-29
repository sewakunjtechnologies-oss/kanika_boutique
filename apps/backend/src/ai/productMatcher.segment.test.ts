import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';

// Drives the REAL matchProduct verifier path with controlled heuristics + a fake
// segmenter (via the segmentation test seam) to prove garment segmentation is
// applied to the images sent to the Gemini selector, and that it falls back to the
// original image when disabled — without loading the heavy native model.
vi.mock('./imageMatcher', () => ({
  inspectImageBuffer: vi.fn(async () => ({ isUsable: true, width: 200, height: 300, format: 'jpeg', sizeBytes: 99 })),
  rankImageMatches: vi.fn(),
}));
vi.mock('./callJsonOutput', () => ({ callJsonOutput: vi.fn() }));
vi.mock('@kda/db', () => ({ prisma: { product: { findMany: vi.fn() } } }));
vi.mock('../storage', () => ({ storage: { resolve: (p: string) => p } }));
vi.mock('node:fs/promises', () => ({
  default: { readFile: vi.fn(async () => Buffer.from('catalog-bytes')) },
  readFile: vi.fn(async () => Buffer.from('catalog-bytes')),
}));

import { rankImageMatches } from './imageMatcher';
import { callJsonOutput } from './callJsonOutput';
import { prisma } from '@kda/db';
import { matchProduct } from './productMatcher';
import { __setSegmenterForTests, clearSegmentationCache } from './segmentation';

function score(productId: string, confidence: number, matchType = 'GENERAL_MATCH') {
  return {
    productId, sku: productId, name: productId, imageUrl: `/uploads/${productId}.jpg`,
    imageId: `${productId}:p`, confidence, matchType,
    averageHashSimilarity: 0.5, differenceHashSimilarity: 0.5, perceptualHashSimilarity: 0.5,
    pixelSimilarity: 0.5, colorPixelSimilarity: 0.5, structuralSimilarity: 0.5, edgeSimilarity: 0.5,
    colorSimilarity: 0.5, garmentColorSimilarity: 0.5, embeddingSimilarity: 0.9, garmentEmbeddingSimilarity: 0.9,
    localFeatureScore: 0.5, localFeatureMatches: 5, localFeatureInlierRatio: 0.3, localFeatureCoverage: 0.3,
    patternSimilarity: 0.9, linePatternSimilarity: 0.9, matchedViewPair: 'garment:garment', cropBoxes: [],
    nearDuplicateScore: 0.5, generalScore: confidence, rawHashMatch: false, decodedHashMatch: false,
    algorithmVersion: 'v', schemaVersion: 1,
  };
}

const products = [
  { id: 'correct', sku: 'C', name: 'Correct', description: '', category: 'Suits', basePrice: { toString: () => '1000' }, imageUrl: '/uploads/correct.jpg', imagePublicId: null, variants: [{ stock: 5 }] },
  { id: 'wrong', sku: 'W', name: 'Wrong', description: '', category: 'Suits', basePrice: { toString: () => '1000' }, imageUrl: '/uploads/wrong.jpg', imagePublicId: null, variants: [{ stock: 5 }] },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearSegmentationCache();
  __setSegmenterForTests(null);
  vi.mocked(prisma.product.findMany).mockResolvedValue(products as never);
  // Heuristic top is a GENERAL match (the unreliable tier) → verifier path.
  vi.mocked(rankImageMatches).mockResolvedValue([score('wrong', 0.92), score('correct', 0.80)] as never);
  // Verifier picks the CORRECT product over the heuristic-top wrong one.
  vi.mocked(callJsonOutput).mockResolvedValue({ result: { matchedProductId: 'correct', confidence: 0.85, reasoning: 'same print' }, usage: {} } as never);
  env.IMAGE_MATCH_THRESHOLD = 0.5;
  env.IMAGE_MIN_SCORE_MARGIN = 0.04;
  env.IMAGE_VERIFY_WITH_AI = true;
  env.IMAGE_VERIFY_TOP_K = 3;
  env.IMAGE_VERIFY_MIN_CONFIDENCE = 0.6;
  env.GEMINI_API_KEY = 'test-key';
  env.IMAGE_SEGMENTATION_ENABLED = false;
});
afterEach(() => {
  __setSegmenterForTests(null);
  clearSegmentationCache();
  env.IMAGE_SEGMENTATION_ENABLED = false;
  env.IMAGE_VERIFY_WITH_AI = false;
});

function selectorImageData(): string[] {
  const call = vi.mocked(callJsonOutput).mock.calls[0]![0];
  const parts = call.contents[0]!.parts as Array<Record<string, any>>;
  return parts.filter((p) => 'inlineData' in p).map((p) => p.inlineData.data as string);
}

describe('matchProduct verifier path — garment segmentation wiring', () => {
  test('segmentation ENABLED → selector receives segmented garment crops; verified product wins', async () => {
    env.IMAGE_SEGMENTATION_ENABLED = true;
    __setSegmenterForTests(async (buf) => Buffer.concat([Buffer.from('SEG:'), buf]));

    const outcome = await matchProduct({ imageBase64: Buffer.from('customer').toString('base64'), imageMediaType: 'image/jpeg' });

    expect(outcome.matchedProductId).toBe('correct');
    expect(outcome.autoConfirm).toBe(true);
    // Every image handed to the verifier is a segmented crop (prefixed by the fake).
    const images = selectorImageData();
    expect(images.length).toBeGreaterThanOrEqual(2);
    for (const data of images) {
      expect(Buffer.from(data, 'base64').toString('latin1').startsWith('SEG:')).toBe(true);
    }
  });

  test('segmentation DISABLED → selector receives ORIGINAL images (graceful no-op), still matches', async () => {
    env.IMAGE_SEGMENTATION_ENABLED = false;

    const outcome = await matchProduct({ imageBase64: Buffer.from('customer').toString('base64'), imageMediaType: 'image/jpeg' });

    expect(outcome.matchedProductId).toBe('correct');
    expect(outcome.autoConfirm).toBe(true);
    const images = selectorImageData();
    for (const data of images) {
      expect(Buffer.from(data, 'base64').toString('latin1').startsWith('SEG:')).toBe(false);
    }
  });

  test('segmenter failure → original image used, matching still succeeds (never crashes)', async () => {
    env.IMAGE_SEGMENTATION_ENABLED = true;
    __setSegmenterForTests(async () => { throw new Error('onnx down'); });

    const outcome = await matchProduct({ imageBase64: Buffer.from('customer').toString('base64'), imageMediaType: 'image/jpeg' });
    expect(outcome.matchedProductId).toBe('correct');
    expect(outcome.autoConfirm).toBe(true);
  });
});
