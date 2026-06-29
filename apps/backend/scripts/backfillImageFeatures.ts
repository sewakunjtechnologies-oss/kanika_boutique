/**
 * Admin backfill: generate image-matching features for every active inventory
 * image and persist them for diagnostics/auditing.
 *
 * Run: npm run backfill:image-features --workspace=@kda/backend
 */
import { prisma } from '@kda/db';
import { fetchCatalog, buildCatalogImageCandidates, IMAGE_MATCH_MODEL_VERSION } from '../src/ai/productMatcher';
import {
  IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
  fingerprintImage,
  inspectImageBuffer,
  serializeImageFingerprint,
} from '../src/ai/imageMatcher';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  const catalog = await fetchCatalog();
  logger.info(
    {
      model: IMAGE_MATCH_MODEL_VERSION,
      schemaVersion: IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
      totalActiveProducts: catalog.length,
    },
    'backfill: active products loaded',
  );

  const candidates = await buildCatalogImageCandidates(catalog);
  const candidatesByProduct = new Map(candidates.map((candidate) => [candidate.productId, candidate]));
  const currentSourceImageIds = new Set(candidates.map((candidate) => candidate.imageId));

  let generatedFeatures = 0;
  let skippedImages = 0;
  let failedImageDownloads = 0;
  const failed: Array<{ productId: string; sku: string; sourceImageId?: string; reason: string }> = [];
  const hashToSources = new Map<string, Array<{ productId: string; sku: string; sourceImageId: string }>>();

  for (const product of catalog) {
    const candidate = candidatesByProduct.get(product.id);
    if (!candidate) {
      skippedImages += 1;
      failedImageDownloads += 1;
      failed.push({ productId: product.id, sku: product.sku, reason: 'image_unreachable_or_missing' });
      continue;
    }

    const diag = await inspectImageBuffer(candidate.imageBuffer);
    if (!diag.isUsable) {
      skippedImages += 1;
      failed.push({
        productId: product.id,
        sku: product.sku,
        sourceImageId: candidate.imageId,
        reason: diag.reason ?? 'unusable',
      });
      continue;
    }

    try {
      const fingerprint = await fingerprintImage(candidate.imageBuffer);
      const serial = serializeImageFingerprint(fingerprint);
      const now = new Date();
      await prisma.productImageFeature.upsert({
        where: {
          sourceImageId_algorithmVersion_schemaVersion: {
            sourceImageId: candidate.imageId,
            algorithmVersion: serial.algorithmVersion,
            schemaVersion: serial.schemaVersion,
          },
        },
        create: {
          sourceImageId: candidate.imageId,
          productId: product.id,
          imageUrl: product.imageUrl ?? '',
          imageHash: serial.rawSha256,
          decodedImageHash: serial.decodedSha256,
          algorithmVersion: serial.algorithmVersion,
          schemaVersion: serial.schemaVersion,
          width: serial.width,
          height: serial.height,
          format: serial.format,
          averageHash: serial.averageHash,
          differenceHash: serial.differenceHash,
          perceptualHash: serial.perceptualHash,
          generatedAt: now,
        },
        update: {
          productId: product.id,
          imageUrl: product.imageUrl ?? '',
          imageHash: serial.rawSha256,
          decodedImageHash: serial.decodedSha256,
          width: serial.width,
          height: serial.height,
          format: serial.format,
          averageHash: serial.averageHash,
          differenceHash: serial.differenceHash,
          perceptualHash: serial.perceptualHash,
          generatedAt: now,
        },
      });
      generatedFeatures += 1;
      const entries = hashToSources.get(serial.rawSha256) ?? [];
      entries.push({ productId: product.id, sku: product.sku, sourceImageId: candidate.imageId });
      hashToSources.set(serial.rawSha256, entries);
    } catch (err) {
      skippedImages += 1;
      failed.push({
        productId: product.id,
        sku: product.sku,
        sourceImageId: candidate.imageId,
        reason: err instanceof Error ? err.message : 'fingerprint_failed',
      });
    }
  }

  if (currentSourceImageIds.size > 0) {
    await prisma.productImageFeature.deleteMany({
      where: {
        productId: { in: catalog.map((product) => product.id) },
        algorithmVersion: IMAGE_MATCH_MODEL_VERSION,
        schemaVersion: IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
        sourceImageId: { notIn: [...currentSourceImageIds] },
      },
    });
  }

  const duplicateImages = [...hashToSources.values()].filter((sources) => sources.length > 1);
  logger.info(
    {
      model: IMAGE_MATCH_MODEL_VERSION,
      schemaVersion: IMAGE_MATCH_FEATURE_SCHEMA_VERSION,
      totalActiveProducts: catalog.length,
      totalValidImages: candidates.length,
      generatedFeatures,
      skippedImages,
      failedImageDownloads,
      duplicateImages: duplicateImages.length,
    },
    'backfill: image feature generation complete',
  );
  if (duplicateImages.length > 0) {
    logger.warn({ duplicateImages }, 'backfill: duplicate inventory images found');
  }
  if (failed.length > 0) {
    logger.warn({ failed }, 'backfill: products that cannot match until images are fixed');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'backfill: failed');
    process.exit(1);
  });
