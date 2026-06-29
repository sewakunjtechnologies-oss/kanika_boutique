/**
 * Protected local/admin diagnostic:
 * npm run diagnose:image-match --workspace=@kda/backend -- ./path/to/image.jpg
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { matchProduct } from '../src/ai/productMatcher';
import { writeImageMatchDebugViews } from '../src/ai/imageMatcher';
import type { SupportedImageMimeType } from '../src/ai/schemas';

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) {
    throw new Error('Usage: diagnoseImageMatch.ts <image-path>');
  }

  const buffer = await fs.readFile(imagePath);
  const debugDir = path.resolve(
    process.cwd(),
    '.tmp',
    'image-match-debug',
    `${Date.now()}-${path.basename(imagePath, path.extname(imagePath)).replace(/[^a-z0-9._-]+/gi, '_')}`,
  );
  const debugViews = await writeImageMatchDebugViews(buffer, debugDir, 'query');
  const outcome = await matchProduct({
    imageBase64: buffer.toString('base64'),
    imageMediaType: guessMime(imagePath),
  });

  const secondScore =
    outcome.candidates.find((candidate) => candidate.productId !== outcome.matchedProductId)?.confidence ?? null;
  const result = {
    decision: outcome.decision,
    decisionReason: outcome.decisionReason,
    matchType: outcome.matchType,
    matchedProductId: outcome.matchedProductId,
    topScore: outcome.confidence,
    secondScore,
    scoreMargin: outcome.bestSecondMargin,
    cleanedImagePreviewPath: debugViews.screenshotClean,
    debugViewPaths: debugViews,
    detectedGarmentBoxes: outcome.candidates[0]?.cropBoxes ?? [],
    candidates: outcome.candidates.slice(0, 5).map((candidate, index) => ({
      rank: index + 1,
      productId: candidate.productId,
      sku: candidate.sku,
      imageId: candidate.imageId,
      imageRef: candidate.imageRef,
      matchType: candidate.matchType,
      combinedScore: candidate.confidence,
      perceptualScore: candidate.perceptualHashSimilarity,
      structuralScore: candidate.structuralSimilarity,
      pixelScore: candidate.pixelSimilarity,
      edgeScore: candidate.edgeSimilarity,
      embeddingScore: candidate.embeddingSimilarity,
      garmentEmbeddingScore: candidate.garmentEmbeddingSimilarity,
      localFeatureScore: candidate.localFeatureScore,
      localFeatureMatches: candidate.localFeatureMatches,
      localFeatureInlierRatio: candidate.localFeatureInlierRatio,
      patternScore: candidate.patternSimilarity,
      linePatternScore: candidate.linePatternSimilarity,
      colourScore: candidate.colorSimilarity,
      garmentColourScore: candidate.garmentColorSimilarity,
      matchedViewPair: candidate.matchedViewPair,
      cropBoxes: candidate.cropBoxes,
      scoreMargin: Math.max(candidate.confidence - (secondScore ?? 0), 0),
      decisionReason: outcome.decisionReason,
    })),
  };
  console.log(JSON.stringify(result, null, 2));
}

function guessMime(filePath: string): SupportedImageMimeType {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
