/* eslint-disable no-console */
/**
 * Local QA smoke checks for the WhatsApp chatbot core.
 *
 * Usage:
 *   npm run qa:bot -w @kda/backend
 *
 * Checks:
 *   - Same inventory image matches its own product with high confidence.
 *   - Unrelated generated image stays below threshold / no match.
 *   - Invalid image returns no match and does not crash.
 *   - In-stock variant returns available.
 *   - Zero-stock variant returns unavailable.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { prisma, Prisma } from '@kda/db';
import { matchProduct } from '../src/ai/productMatcher';
import type { SupportedImageMimeType } from '../src/ai/schemas';
import { checkStock } from '../src/chatbot/orderService';
import { storage } from '../src/storage';

interface StepResult {
  name: string;
  ok: boolean;
  detail?: unknown;
}

const results: StepResult[] = [];

async function main(): Promise<void> {
  const product = await prisma.product.findFirst({
    where: {
      isActive: true,
      imageUrl: { not: '' },
      variants: { some: { stock: { gt: 0 } } },
    },
    include: { variants: true },
    orderBy: { createdAt: 'desc' },
  });
  assertStep('catalog_has_active_product_with_stock_and_image', Boolean(product));
  if (!product) return finish();

  const productImage = await readProductImage(product.imageUrl);
  const same = await matchProduct({
    imageBase64: productImage.toString('base64'),
    imageMediaType: guessMime(product.imageUrl),
  });
  assertStep('same_inventory_image_high_confidence', same.meetsThreshold && same.matchedProductId === product.id, same);

  const differentImage = await sharp({
    create: {
      width: 600,
      height: 900,
      channels: 3,
      background: { r: 5, g: 5, b: 5 },
    },
  })
    .jpeg()
    .toBuffer();
  const different = await matchProduct({
    imageBase64: differentImage.toString('base64'),
    imageMediaType: 'image/jpeg',
  });
  assertStep('different_image_low_confidence', !different.meetsThreshold, different);

  const invalid = await matchProduct({
    imageBase64: Buffer.from('not an image').toString('base64'),
    imageMediaType: 'image/jpeg',
  });
  assertStep('invalid_image_no_crash', !invalid.meetsThreshold, invalid);

  const inStockVariant = product.variants.find((v) => v.stock > 0);
  assertStep('catalog_has_in_stock_variant', Boolean(inStockVariant));
  if (inStockVariant) {
    const stock = await checkStock(product.id, inStockVariant.size, 1);
    assertStep('stock_gt_zero_available', stock.available && stock.stock > 0, stock);
  }

  const zeroSku = `QA-ZERO-${Date.now()}`;
  const zeroProduct = await prisma.product.create({
    data: {
      sku: zeroSku,
      name: 'QA Zero Stock Suit',
      description: 'Temporary QA product created by qaSmoke.ts',
      category: 'Suits',
      basePrice: new Prisma.Decimal(1),
      imageUrl: product.imageUrl,
      isActive: true,
      variants: { create: [{ size: 'QA', stock: 0, color: null }] },
    },
    include: { variants: true },
  });

  try {
    const zeroStock = await checkStock(zeroProduct.id, 'QA', 1);
    assertStep('stock_zero_unavailable', !zeroStock.available && zeroStock.stock === 0, zeroStock);
  } finally {
    await prisma.product.delete({ where: { id: zeroProduct.id } });
  }

  finish();
}

async function readProductImage(imageUrl: string): Promise<Buffer> {
  if (imageUrl.startsWith('/uploads/') || imageUrl.startsWith('/api/uploads/')) {
    const rel = imageUrl.replace(/^\/api\/uploads\//, '').replace(/^\/uploads\//, '');
    return fs.readFile(storage.resolve(rel));
  }
  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error(`failed to fetch product image ${imageUrl}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return fs.readFile(path.resolve(imageUrl));
}

function guessMime(filename: string): SupportedImageMimeType {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function assertStep(name: string, ok: boolean, detail?: unknown): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (!ok && detail !== undefined) console.log(JSON.stringify(detail, null, 2));
}

function finish(): void {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) process.exit(1);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
