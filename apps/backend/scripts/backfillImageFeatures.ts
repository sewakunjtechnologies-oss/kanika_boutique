/**
 * Admin backfill: regenerate/verify image-matching features for every active
 * inventory product. Because perceptual hashes are computed per request, this
 * command's job is to PROVE every active product has a reachable, decodable,
 * non-blank image so a real customer photo can produce candidateCount > 0.
 *
 * Run: npm run backfill:image-features --workspace=@kda/backend
 */
import { fetchCatalog, buildCatalogImageCandidates, IMAGE_MATCH_MODEL_VERSION } from '../src/ai/productMatcher';
import { fingerprintImage, inspectImageBuffer } from '../src/ai/imageMatcher';
import { logger } from '../src/logger';

async function main(): Promise<void> {
  const catalog = await fetchCatalog();
  logger.info({ model: IMAGE_MATCH_MODEL_VERSION, products: catalog.length }, 'backfill: active products loaded');

  const candidates = await buildCatalogImageCandidates(catalog);
  const withImage = new Set(candidates.map((c) => c.productId));

  let ok = 0;
  const failures: Array<{ productId: string; sku: string; reason: string }> = [];

  for (const product of catalog) {
    if (!withImage.has(product.id)) {
      failures.push({ productId: product.id, sku: product.sku, reason: 'image_unreachable_or_missing' });
      continue;
    }
    const candidate = candidates.find((c) => c.productId === product.id)!;
    const diag = await inspectImageBuffer(candidate.imageBuffer);
    if (!diag.isUsable) {
      failures.push({ productId: product.id, sku: product.sku, reason: diag.reason ?? 'unusable' });
      continue;
    }
    try {
      await fingerprintImage(candidate.imageBuffer); // regenerate perceptual features
      ok += 1;
    } catch (err) {
      failures.push({ productId: product.id, sku: product.sku, reason: err instanceof Error ? err.message : 'fingerprint_failed' });
    }
  }

  logger.info(
    { model: IMAGE_MATCH_MODEL_VERSION, products: catalog.length, ok, failed: failures.length },
    'backfill: image feature regeneration complete',
  );
  if (failures.length > 0) {
    logger.warn({ failures }, 'backfill: products that cannot match — fix their images (Cloudinary/public URL)');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ err }, 'backfill: failed');
    process.exit(1);
  });
