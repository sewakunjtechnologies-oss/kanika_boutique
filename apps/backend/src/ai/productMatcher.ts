import fs from 'node:fs/promises';
import axios from 'axios';
import type { Part } from '@google/genai';
import { prisma } from '@kda/db';
import { callJsonOutput } from './callJsonOutput';
import { botError, botLog, logger } from '../logger';
import { env } from '../config/env';
import { storage } from '../storage';
import {
  PRODUCT_MATCH_RESPONSE_SCHEMA,
  ProductMatchResultSchema,
  type ProductMatchResult,
  type SupportedImageMimeType,
} from './schemas';
import {
  inspectImageBuffer,
  rankImageMatches,
  type ImageMatchType,
  type ImageMatchScore,
  type ImageCandidate,
  type ImageViewBox,
} from './imageMatcher';

export const PRODUCT_MATCH_CONFIDENCE_THRESHOLD = 0.5;
export const MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD = 0.5;

export type ProductMatchConfidenceBand = 'high' | 'medium' | 'low';
export type ProductMatchDecision = 'auto_match' | 'candidate_confirmation' | 'no_match';

export interface ProductMatchCandidate {
  productId: string;
  sku: string;
  name: string;
  imageUrl: string;
  confidence: number;
  imageId?: string;
  imageRef?: string;
  matchType?: ImageMatchType;
  averageHashSimilarity?: number;
  differenceHashSimilarity?: number;
  perceptualHashSimilarity?: number;
  pixelSimilarity?: number;
  colorPixelSimilarity?: number;
  structuralSimilarity?: number;
  edgeSimilarity?: number;
  colorSimilarity?: number;
  garmentColorSimilarity?: number;
  embeddingSimilarity?: number | null;
  garmentEmbeddingSimilarity?: number;
  localFeatureScore?: number;
  localFeatureMatches?: number;
  localFeatureInlierRatio?: number;
  localFeatureCoverage?: number;
  patternSimilarity?: number;
  linePatternSimilarity?: number;
  matchedViewPair?: string | null;
  cropBoxes?: ImageViewBox[];
  nearDuplicateScore?: number;
  generalScore?: number;
}

export interface CatalogEntry {
  id: string;
  sku: string;
  name: string;
  description?: string;
  category: string;
  basePrice: string;
  imageUrl?: string;
  imagePublicId?: string | null;
  totalStock?: number;
}

export interface ProductMatchInput {
  imageBase64: string;
  imageMediaType?: SupportedImageMimeType;
  /** Injectable for tests; otherwise fetched from DB. */
  catalog?: CatalogEntry[];
}

export interface ProductMatchOutcome extends ProductMatchResult {
  meetsThreshold: boolean;
  confidenceBand: ProductMatchConfidenceBand;
  decision: ProductMatchDecision;
  candidates: ProductMatchCandidate[];
  bestSecondMargin: number | null;
  matchType: ImageMatchType | null;
  decisionReason: string;
}

export function classifyProductMatchConfidence(confidence: number): ProductMatchConfidenceBand {
  // A single canonical threshold (env.IMAGE_MATCH_THRESHOLD) governs auto-match.
  // The previous implementation had two identical comparisons, making 'medium'
  // unreachable; the band is intentionally binary (high/low) around the threshold.
  if (confidence >= env.IMAGE_MATCH_THRESHOLD) return 'high';
  return 'low';
}

export function hasClearBestImageCandidate(
  bestConfidence: number | null | undefined,
  secondBestConfidence: number | null | undefined,
  requiredMargin = env.IMAGE_MIN_SCORE_MARGIN,
): boolean {
  if (bestConfidence === null || bestConfidence === undefined) return false;
  if (secondBestConfidence === null || secondBestConfidence === undefined) return true;
  return Math.max(bestConfidence - secondBestConfidence, 0) >= requiredMargin;
}

export function classifyImageMatchDecision(
  topScore: number,
  margin: number | null | undefined,
  matchType: ImageMatchType = 'GENERAL_MATCH',
): ProductMatchDecision {
  if (matchType === 'EXACT_MATCH') return 'auto_match';
  if (matchType === 'NEAR_DUPLICATE_MATCH' && topScore >= env.IMAGE_MATCH_THRESHOLD) return 'auto_match';
  if (matchType === 'LOCAL_FEATURE_MATCH' && topScore >= env.IMAGE_MATCH_THRESHOLD) return 'auto_match';
  if (matchType === 'GARMENT_EMBEDDING_MATCH' && topScore >= env.IMAGE_MATCH_THRESHOLD) return 'auto_match';
  const clearMargin = margin === null || margin === undefined || margin >= env.IMAGE_MIN_SCORE_MARGIN;
  if (topScore >= env.IMAGE_MATCH_THRESHOLD && clearMargin) return 'auto_match';
  return 'no_match';
}

const SYSTEM_PROMPT = `You match Indian ethnic-wear photos to a boutique's catalog.

The boutique sells: Suits (Anarkali, salwar, churidar), Lehengas, Sarees, Kurtis.
You will be given a customer's photo + the boutique's catalog (id, sku, category, name, price, stock).
When available, catalog photos are included immediately after a text label containing their product id.

Match primarily on the catalog photos. Use text metadata only as supporting evidence.
Match on: garment type (suit/lehenga/saree/kurti), dominant color(s), pattern, embroidery/print, style.
Return matchedProductId set to one of the listed product IDs, or null if no item is a clear visual match.
Confidence reflects how visually similar the matched item is. Below 0.8 = "uncertain" — prefer null.

Return ONLY JSON: { "matchedProductId": string|null, "confidence": 0.0-1.0, "reasoning": "brief" }`;

export async function matchProduct(input: ProductMatchInput): Promise<ProductMatchOutcome> {
  const catalog = input.catalog ?? (await fetchCatalog());
  if (catalog.length === 0) {
    return {
      matchedProductId: null,
      confidence: 0,
      reasoning: 'catalog is empty',
      meetsThreshold: false,
      confidenceBand: 'low',
      decision: 'no_match',
      candidates: [],
      bestSecondMargin: null,
      matchType: null,
      decisionReason: 'empty_catalog',
    };
  }

  const validIds = new Set(catalog.map((c) => c.id));
  const queryBuffer = Buffer.from(input.imageBase64, 'base64');
  const queryDiagnostics = await inspectImageBuffer(queryBuffer);
  if (!queryDiagnostics.isUsable) {
    botLog('IMAGE_MATCH_DIAGNOSTICS', {
      query: queryDiagnostics,
      decision: 'no_match',
    });
    return {
      matchedProductId: null,
      confidence: 0,
      reasoning: `customer image rejected: ${queryDiagnostics.reason ?? 'unusable_image'}`,
      meetsThreshold: false,
      confidenceBand: 'low',
      decision: 'no_match',
      candidates: [],
      bestSecondMargin: null,
      matchType: null,
      decisionReason: queryDiagnostics.reason ?? 'unusable_image',
    };
  }

  const catalogImages = input.catalog ? [] : await buildCatalogImageCandidates(catalog);
  botLog('IMAGE_MATCH_CANDIDATES_LOADED', {
    candidateCount: catalogImages.length,
    catalogSize: catalog.length,
  });
  botLog(
    'IMAGE_MATCH_STARTED',
    {
      catalogSize: catalog.length,
      catalogImageCount: catalogImages.length,
      queryImage: queryDiagnostics,
    },
  );

  if (catalogImages.length > 0) {
    let ranked: Awaited<ReturnType<typeof rankImageMatches>>;
    try {
      ranked = await rankImageMatches(queryBuffer, catalogImages);
    } catch (err) {
      botError('ERROR_DETAILS', err, { step: 'perceptual_image_match' });
      return {
        matchedProductId: null,
        confidence: 0,
        reasoning: 'image could not be decoded for matching',
        meetsThreshold: false,
        confidenceBand: 'low',
        decision: 'no_match',
        candidates: [],
        bestSecondMargin: null,
        matchType: null,
        decisionReason: 'decode_failed',
      };
    }
    const best = ranked[0];
    const second = ranked[1];
    const candidates = ranked.slice(0, 5).map(scoreToCandidate);
    const confidenceBand = classifyProductMatchConfidence(best?.confidence ?? 0);
    const bestSecondMargin = best && second ? Math.max(best.confidence - second.confidence, 0) : best ? 1 : null;
    const bypassGenericMargin =
      best?.matchType === 'EXACT_MATCH' ||
      best?.matchType === 'NEAR_DUPLICATE_MATCH' ||
      best?.matchType === 'LOCAL_FEATURE_MATCH' ||
      best?.matchType === 'GARMENT_EMBEDDING_MATCH';
    const hasClearBestMatch =
      bypassGenericMargin || hasClearBestImageCandidate(best?.confidence, second?.confidence);
    const decision = classifyImageMatchDecision(best?.confidence ?? 0, bestSecondMargin, best?.matchType);
    const finalDecision = classifyStructuredImageDecision(best, decision, bestSecondMargin);
    logImageMatchStages(ranked, catalogImages.length, bestSecondMargin, finalDecision);

    if (best && decision === 'auto_match' && confidenceBand === 'high' && hasClearBestMatch) {
      return {
        matchedProductId: best.productId,
        confidence: best.confidence,
        reasoning: `${best.matchType.toLowerCase()} against catalog image for ${best.sku}`,
        meetsThreshold: true,
        confidenceBand,
        decision: 'auto_match',
        candidates,
        bestSecondMargin,
        matchType: best.matchType,
        decisionReason: best.matchType,
      };
    }

    if (!env.CHATBOT_ENABLE_AI_IMAGE_MATCHING) {
      return {
        matchedProductId: null,
        confidence: best?.confidence ?? 0,
        reasoning: best
          ? hasClearBestMatch
            ? `best perceptual match ${best.sku} was below auto-match threshold`
            : `best perceptual match ${best.sku} was too close to the second-best match`
          : 'no usable catalog images',
        meetsThreshold: false,
        confidenceBand,
        decision,
        candidates,
        bestSecondMargin,
        matchType: best?.matchType ?? null,
        decisionReason: hasClearBestMatch ? 'below_threshold' : 'ambiguous_margin',
      };
    }
  }

  if (!env.CHATBOT_ENABLE_AI_IMAGE_MATCHING) {
    return {
      matchedProductId: null,
      confidence: 0,
      reasoning: 'no deterministic image match and AI image matching disabled',
      meetsThreshold: false,
      confidenceBand: 'low',
      decision: 'no_match',
      candidates: [],
      bestSecondMargin: null,
      matchType: null,
      decisionReason: 'deterministic_no_match_ai_disabled',
    };
  }

  const catalogImageParts = buildCatalogImageParts(catalogImages);
  const { result, usage } = await callJsonOutput({
    systemPrompt: SYSTEM_PROMPT,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: {
              mimeType: input.imageMediaType ?? 'image/jpeg',
              data: input.imageBase64,
            },
          },
          {
            text: `Boutique catalog:\n${formatCatalog(catalog)}\n\nPick the best visual match. Return JSON.`,
          },
          ...catalogImageParts,
        ],
      },
    ],
    responseSchema: PRODUCT_MATCH_RESPONSE_SCHEMA,
    schema: ProductMatchResultSchema,
    maxOutputTokens: 512,
  });

  if (!result) {
    return {
      matchedProductId: null,
      confidence: 0,
      reasoning: 'matcher returned no valid output',
      meetsThreshold: false,
      confidenceBand: 'low',
      decision: 'no_match',
      candidates: [],
      bestSecondMargin: null,
      matchType: null,
      decisionReason: 'ai_invalid_output',
    };
  }

  if (result.matchedProductId !== null && !validIds.has(result.matchedProductId)) {
    logger.warn(
      { returnedId: result.matchedProductId, catalogSize: catalog.length },
      'product matcher returned an ID not present in catalog',
    );
    return {
      ...result,
      matchedProductId: null,
      meetsThreshold: false,
      confidenceBand: 'low',
      decision: 'no_match',
      candidates: [],
      bestSecondMargin: null,
      matchType: null,
      decisionReason: 'ai_returned_unknown_product',
    };
  }

  const confidenceBand = classifyProductMatchConfidence(result.confidence);
  const aiCandidate =
    result.matchedProductId === null
      ? null
      : catalog.find((entry) => entry.id === result.matchedProductId) ?? null;
  const candidates =
    aiCandidate
      ? [
          {
            productId: aiCandidate.id,
            sku: aiCandidate.sku,
            name: aiCandidate.name,
            imageUrl: aiCandidate.imageUrl ?? '',
            confidence: result.confidence,
          },
        ]
      : [];
  const meetsThreshold = result.matchedProductId !== null && result.confidence >= env.IMAGE_MATCH_THRESHOLD;
  const decision: ProductMatchDecision = meetsThreshold
    ? 'auto_match'
    : 'no_match';

  logger.debug(
    {
      matchedProductId: result.matchedProductId,
      confidence: result.confidence,
      meetsThreshold,
      usage,
      matcher: 'gemini_fallback',
    },
    'product match attempt',
  );
  return {
    ...result,
    matchedProductId: decision === 'no_match' ? null : result.matchedProductId,
    meetsThreshold,
    confidenceBand,
    decision,
    candidates,
    bestSecondMargin: null,
    matchType: 'GENERAL_MATCH',
    decisionReason: decision === 'auto_match' ? 'gemini_fallback' : 'below_threshold',
  };
}

function scoreToCandidate(score: ImageMatchScore): ProductMatchCandidate {
  return {
    productId: score.productId,
    sku: score.sku,
    name: score.name,
    imageUrl: score.imageUrl,
    confidence: score.confidence,
    imageId: score.imageId,
    imageRef: safeImageRef(score.imageUrl),
    matchType: score.matchType,
    averageHashSimilarity: score.averageHashSimilarity,
    differenceHashSimilarity: score.differenceHashSimilarity,
    perceptualHashSimilarity: score.perceptualHashSimilarity,
    pixelSimilarity: score.pixelSimilarity,
    colorPixelSimilarity: score.colorPixelSimilarity,
    structuralSimilarity: score.structuralSimilarity,
    edgeSimilarity: score.edgeSimilarity,
    colorSimilarity: score.colorSimilarity,
    garmentColorSimilarity: score.garmentColorSimilarity,
    embeddingSimilarity: score.embeddingSimilarity,
    garmentEmbeddingSimilarity: score.garmentEmbeddingSimilarity,
    localFeatureScore: score.localFeatureScore,
    localFeatureMatches: score.localFeatureMatches,
    localFeatureInlierRatio: score.localFeatureInlierRatio,
    localFeatureCoverage: score.localFeatureCoverage,
    patternSimilarity: score.patternSimilarity,
    linePatternSimilarity: score.linePatternSimilarity,
    matchedViewPair: score.matchedViewPair,
    cropBoxes: score.cropBoxes,
    nearDuplicateScore: score.nearDuplicateScore,
    generalScore: score.generalScore,
  };
}

type StructuredImageDecision =
  | 'EXACT_MATCH'
  | 'NEAR_DUPLICATE_MATCH'
  | 'LOCAL_FEATURE_MATCH'
  | 'GARMENT_EMBEDDING_MATCH'
  | 'GENERAL_MATCH'
  | 'AMBIGUOUS'
  | 'NO_MATCH';

function classifyStructuredImageDecision(
  best: ImageMatchScore | undefined,
  decision: ProductMatchDecision,
  margin: number | null,
): StructuredImageDecision {
  if (!best) return 'NO_MATCH';
  if (decision === 'auto_match') return best.matchType;
  if (best.confidence >= env.IMAGE_MATCH_THRESHOLD && margin !== null && margin < env.IMAGE_MIN_SCORE_MARGIN) {
    return 'AMBIGUOUS';
  }
  return 'NO_MATCH';
}

function logImageMatchStages(
  ranked: ImageMatchScore[],
  candidateCount: number,
  scoreMargin: number | null,
  finalDecision: StructuredImageDecision,
): void {
  const best = ranked[0];
  const second = ranked[1];
  const exactCount = ranked.filter((score) => score.matchType === 'EXACT_MATCH').length;
  const nearDuplicateCount = ranked.filter((score) => score.matchType === 'NEAR_DUPLICATE_MATCH').length;
  const localFeatureCount = ranked.filter((score) => score.matchType === 'LOCAL_FEATURE_MATCH').length;
  const garmentEmbeddingCount = ranked.filter((score) => score.matchType === 'GARMENT_EMBEDDING_MATCH').length;
  const generalCount = ranked.filter((score) => score.matchType === 'GENERAL_MATCH').length;

  botLog('IMAGE_MATCH_EXACT_HASH_CHECK', {
    candidateCount,
    exactMatchCount: exactCount,
    topSku: best?.matchType === 'EXACT_MATCH' ? best.sku : null,
    topScore: best?.matchType === 'EXACT_MATCH' ? best.confidence : null,
  });
  botLog('IMAGE_MATCH_NEAR_DUPLICATE_CHECK', {
    candidateCount,
    nearDuplicateCount,
    threshold: env.IMAGE_NEAR_DUPLICATE_THRESHOLD,
    pHashThreshold: env.IMAGE_NEAR_DUPLICATE_PHASH_THRESHOLD,
    pixelThreshold: env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD,
    edgeThreshold: env.IMAGE_NEAR_DUPLICATE_EDGE_THRESHOLD,
    featureThreshold: env.IMAGE_NEAR_DUPLICATE_FEATURE_THRESHOLD,
    topSku: best?.matchType === 'NEAR_DUPLICATE_MATCH' ? best.sku : null,
    topScore: best?.matchType === 'NEAR_DUPLICATE_MATCH' ? best.confidence : null,
  });
  botLog('IMAGE_MATCH_LOCAL_FEATURE_CHECK', {
    candidateCount,
    localFeatureCount,
    threshold: env.IMAGE_LOCAL_FEATURE_THRESHOLD,
    minMatches: env.IMAGE_LOCAL_FEATURE_MIN_MATCHES,
    minInlierRatio: env.IMAGE_LOCAL_FEATURE_MIN_INLIER_RATIO,
    minEdgeSimilarity: env.IMAGE_LOCAL_FEATURE_MIN_EDGE_SIMILARITY,
    minLinePatternSimilarity: env.IMAGE_LOCAL_FEATURE_MIN_LINE_PATTERN_SIMILARITY,
    topSku: best?.matchType === 'LOCAL_FEATURE_MATCH' ? best.sku : null,
    topScore: best?.matchType === 'LOCAL_FEATURE_MATCH' ? best.confidence : null,
    topLocalFeatureScore: best?.localFeatureScore ?? null,
    topLocalFeatureMatches: best?.localFeatureMatches ?? null,
    topMatchedViewPair: best?.matchedViewPair ?? null,
  });
  botLog('IMAGE_MATCH_GARMENT_EMBEDDING_CHECK', {
    candidateCount,
    garmentEmbeddingCount,
    threshold: env.IMAGE_GARMENT_EMBEDDING_THRESHOLD,
    minEdgeSimilarity: env.IMAGE_GARMENT_EMBEDDING_MIN_EDGE_SIMILARITY,
    minLinePatternSimilarity: env.IMAGE_GARMENT_EMBEDDING_MIN_LINE_PATTERN_SIMILARITY,
    topSku: best?.matchType === 'GARMENT_EMBEDDING_MATCH' ? best.sku : null,
    topScore: best?.matchType === 'GARMENT_EMBEDDING_MATCH' ? best.confidence : null,
    topEmbeddingScore: best?.garmentEmbeddingSimilarity ?? null,
  });
  botLog('IMAGE_MATCH_GENERAL_CHECK', {
    candidateCount,
    generalCount,
    threshold: env.IMAGE_MATCH_THRESHOLD,
    requiredMargin: env.IMAGE_MIN_SCORE_MARGIN,
    topSku: best?.sku ?? null,
    topScore: best?.confidence ?? null,
    secondScore: second?.confidence ?? null,
    scoreMargin,
  });
  botLog('IMAGE_MATCH_TOP_CANDIDATES', {
    candidateCount,
    candidates: ranked.slice(0, 5).map((score, index) => scoreToLog(score, index)),
  });
  botLog('IMAGE_MATCH_DECISION', {
    candidateCount,
    topSku: best?.sku ?? null,
    topScore: best?.confidence ?? 0,
    secondScore: second?.confidence ?? null,
    scoreMargin,
    matchType: best?.matchType ?? null,
    finalDecision,
    threshold: env.IMAGE_MATCH_THRESHOLD,
    requiredMargin: env.IMAGE_MIN_SCORE_MARGIN,
  });
}

function scoreToLog(score: ImageMatchScore, index: number): Record<string, unknown> {
  return {
    rank: index + 1,
    productId: score.productId,
    sku: score.sku,
    imageId: score.imageId,
    imageRef: safeImageRef(score.imageUrl),
    matchType: score.matchType,
    combinedScore: score.confidence,
    perceptualScore: score.perceptualHashSimilarity,
    averageHashSimilarity: score.averageHashSimilarity,
    differenceHashSimilarity: score.differenceHashSimilarity,
    structuralScore: score.structuralSimilarity,
    pixelScore: score.pixelSimilarity,
    colourPixelScore: score.colorPixelSimilarity,
    edgeScore: score.edgeSimilarity,
    embeddingScore: score.embeddingSimilarity,
    garmentEmbeddingScore: score.garmentEmbeddingSimilarity,
    localFeatureScore: score.localFeatureScore,
    localFeatureMatches: score.localFeatureMatches,
    localFeatureInlierRatio: score.localFeatureInlierRatio,
    localFeatureCoverage: score.localFeatureCoverage,
    patternScore: score.patternSimilarity,
    linePatternScore: score.linePatternSimilarity,
    matchedViewPair: score.matchedViewPair,
    colourScore: score.colorSimilarity,
    garmentColourScore: score.garmentColorSimilarity,
    nearDuplicateScore: score.nearDuplicateScore,
    generalScore: score.generalScore,
    rawHashMatch: score.rawHashMatch,
    decodedHashMatch: score.decodedHashMatch,
  };
}

/** Identifier for the active image-matching technique. Bump when the technique changes. */
export const IMAGE_MATCH_MODEL_VERSION = 'garment-local-v4';

export async function fetchCatalog(): Promise<CatalogEntry[]> {
  const products = await prisma.product.findMany({
    where: { isActive: true, variants: { some: { isActive: true, stock: { gt: 0 } } } },
    select: {
      id: true,
      sku: true,
      name: true,
      description: true,
      category: true,
      basePrice: true,
      imageUrl: true,
      imagePublicId: true,
      variants: { where: { isActive: true }, select: { stock: true } },
    },
    orderBy: { category: 'asc' },
  });
  return products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    description: p.description,
    category: p.category,
    basePrice: p.basePrice.toString(),
    imageUrl: p.imageUrl,
    imagePublicId: p.imagePublicId,
    totalStock: p.variants.reduce((sum, v) => sum + v.stock, 0),
  }));
}

function formatCatalog(catalog: CatalogEntry[]): string {
  return catalog
    .map(
      (p) =>
        `- id=${p.id} | sku=${p.sku} | ${p.category} | ${p.name} | ${p.description ?? ''} | ₹${p.basePrice} | stock=${p.totalStock ?? 'unknown'}`,
    )
    .join('\n');
}

interface CatalogImageCandidate extends ImageCandidate {
  mimeType: SupportedImageMimeType;
}

function buildCatalogImageParts(catalogImages: CatalogImageCandidate[]): Part[] {
  const parts: Part[] = [];
  for (const product of catalogImages.slice(0, 30)) {
    parts.push({
      text: `Catalog photo for product id=${product.productId}, sku=${product.sku}, name=${product.name}`,
    });
    parts.push({
      inlineData: {
        mimeType: product.mimeType,
        data: product.imageBuffer.toString('base64'),
      },
    });
  }
  logger.debug({ imageCount: parts.length / 2 }, 'catalog images added to product matcher prompt');
  return parts;
}

export async function buildCatalogImageCandidates(catalog: CatalogEntry[]): Promise<CatalogImageCandidate[]> {
  const candidates: CatalogImageCandidate[] = [];
  for (const product of catalog) {
    const image = await loadCatalogImageBuffer(product.imageUrl ?? '');
    if (!image) continue;
    candidates.push({
      productId: product.id,
      sku: product.sku,
      name: product.name,
      imageUrl: product.imageUrl ?? '',
      imageId: product.imagePublicId ?? `${product.id}:primary`,
      imageBuffer: image.buffer,
      mimeType: image.mimeType,
    });
  }
  return candidates;
}

async function loadCatalogImageBuffer(
  imageUrl: string,
): Promise<{ mimeType: SupportedImageMimeType; buffer: Buffer } | null> {
  if (!imageUrl) return null;
  try {
    if (imageUrl.startsWith('/uploads/') || imageUrl.startsWith('/api/uploads/')) {
      const rel = imageUrl.replace(/^\/api\/uploads\//, '').replace(/^\/uploads\//, '');
      const buf = await fs.readFile(storage.resolve(rel));
      return { mimeType: guessImageMime(imageUrl), buffer: buf };
    }

    if (imageUrl.startsWith(env.PUBLIC_BACKEND_URL)) {
      const parsed = new URL(imageUrl);
      if (parsed.pathname.startsWith('/api/uploads/') || parsed.pathname.startsWith('/uploads/')) {
        const rel = parsed.pathname.replace(/^\/api\/uploads\//, '').replace(/^\/uploads\//, '');
        const buf = await fs.readFile(storage.resolve(rel));
        return { mimeType: guessImageMime(parsed.pathname), buffer: buf };
      }
    }

    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      const resp = await axios.get<ArrayBuffer>(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 10_000,
        maxContentLength: 5 * 1024 * 1024,
      });
      const contentType = String(resp.headers['content-type'] ?? '');
      if (contentType && !contentType.toLowerCase().startsWith('image/')) {
        botLog('CATALOG_IMAGE_SKIPPED', {
          reason: 'non_image_content_type',
          contentType,
          imageRef: safeImageRef(imageUrl),
        });
        return null;
      }
      return {
        mimeType: normalizeImageMime(contentType || imageUrl),
        buffer: Buffer.from(resp.data),
      };
    }
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'load_catalog_image_for_matcher', imageRef: safeImageRef(imageUrl) });
  }
  return null;
}

function safeImageRef(imageUrl: string): string {
  if (!imageUrl) return '';
  try {
    const parsed = new URL(imageUrl, env.PUBLIC_BACKEND_URL);
    const filename = parsed.pathname.split('/').filter(Boolean).pop() ?? 'image';
    return `${parsed.hostname || 'local'}/.../${filename}`;
  } catch {
    return imageUrl.split('/').filter(Boolean).slice(-2).join('/');
  }
}

function guessImageMime(filenameOrMime: string): SupportedImageMimeType {
  return normalizeImageMime(filenameOrMime);
}

function normalizeImageMime(value: string): SupportedImageMimeType {
  const v = value.toLowerCase();
  if (v.includes('png')) return 'image/png';
  if (v.includes('webp')) return 'image/webp';
  if (v.includes('gif')) return 'image/gif';
  return 'image/jpeg';
}
