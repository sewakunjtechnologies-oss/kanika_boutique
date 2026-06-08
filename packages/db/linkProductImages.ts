/**
 * One-shot: take the WhatsApp-named photos already in uploads/products/,
 * copy each to a SKU-named file, point each Product.imageUrl at it.
 *
 * Re-runnable — uses copyFile (idempotent overwrite). Safe to delete the
 * source WhatsApp files after running; the SKU-named copies stay.
 *
 * Run: npm run db:link:images
 */
/* eslint-disable no-console */
import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ROOT = path.resolve(__dirname, '../..');
const UPLOADS_PRODUCTS = path.join(ROOT, 'uploads', 'products');

// Mapping I identified by reading each image.
const MAPPING: Array<{ sku: string; source: string }> = [
  { sku: 'KDA-MUSTARD-01', source: 'WhatsApp Image 2026-05-30 at 12.20.37.jpeg' },
  { sku: 'KDA-WHITE-FLORAL-01', source: 'WhatsApp Image 2026-05-30 at 12.20.37 (1).jpeg' },
  { sku: 'KDA-RED-COORD-01', source: 'WhatsApp Image 2026-05-30 at 12.20.38.jpeg' },
  { sku: 'KDA-ART4-TEAL', source: 'WhatsApp Image 2026-05-30 at 12.20.38 (1).jpeg' },
  { sku: 'KDA-ART4-PINK', source: 'WhatsApp Image 2026-05-30 at 12.20.38 (2).jpeg' },
  { sku: 'KDA-ART1-BLUE', source: 'WhatsApp Image 2026-05-30 at 12.20.39.jpeg' },
  { sku: 'KDA-ART1-ORANGE', source: 'WhatsApp Image 2026-05-30 at 12.20.39 (1).jpeg' },
];

async function main(): Promise<void> {
  await fs.mkdir(UPLOADS_PRODUCTS, { recursive: true });

  for (const { sku, source } of MAPPING) {
    const sourcePath = path.join(UPLOADS_PRODUCTS, source);
    const destName = `${sku}.jpg`;
    const destPath = path.join(UPLOADS_PRODUCTS, destName);

    // If the source isn't there but the dest already is, just refresh the DB row.
    const sourceExists = await fs
      .access(sourcePath)
      .then(() => true)
      .catch(() => false);
    const destExists = await fs
      .access(destPath)
      .then(() => true)
      .catch(() => false);

    if (sourceExists) {
      await fs.copyFile(sourcePath, destPath);
    } else if (!destExists) {
      console.log(`  ⚠ ${sku}: neither source nor dest exists — skipping`);
      continue;
    }

    const imageUrl = `/api/uploads/products/${destName}`;
    await prisma.product.update({
      where: { sku },
      data: { imageUrl },
    });
    console.log(`  ✓ ${sku.padEnd(22)} → ${destName}`);
  }

  // Clean up the leftover UUID-named file from earlier dashboard testing.
  const stray = '52cb56d5-c95b-4d8c-bcd2-5294cd924e2e.jpeg';
  const strayPath = path.join(UPLOADS_PRODUCTS, stray);
  if (await fs.access(strayPath).then(() => true).catch(() => false)) {
    await fs.unlink(strayPath);
    console.log(`  ✓ removed stray ${stray}`);
  }

  console.log('Done.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
