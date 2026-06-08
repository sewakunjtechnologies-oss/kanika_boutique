/**
 * Seed sample suit catalog.
 *
 * Run:  npm run db:seed:products
 *
 * Idempotent — re-running upserts each product, resets every variant stock to STOCK_PER_SIZE.
 * Replace placeholder imageUrls by editing each product at /inventory/[id] in the dashboard.
 */
/* eslint-disable no-console */
import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();

const SIZES = ['36', '38', '40', '42', '44', '46'];
const STOCK_PER_SIZE = 10;

interface ProductSpec {
  sku: string;
  name: string;
  description: string;
  category: string;
  basePrice: number;
  imageUrl: string;
}

const PRODUCTS: ProductSpec[] = [
  {
    sku: 'KDA-MUSTARD-01',
    name: 'Mustard Yellow Embroidered Cotton Suit Set',
    description:
      'Mustard yellow kurta with embroidered yoke, matching straight pants and printed dupatta. Pure cotton.',
    category: 'Suits',
    basePrice: 1500, // placeholder — image had no visible price
    imageUrl: 'https://placehold.co/600x900/fbbf24/333?text=Mustard+Suit',
  },
  {
    sku: 'KDA-ART1-BLUE',
    name: 'Article 1 — Blue Floral Pure Cotton Suit',
    description:
      'Pure cotton suit set with blue and green floral block print. Includes kurta, pants, and matching printed dupatta.',
    category: 'Suits',
    basePrice: 2270,
    imageUrl: 'https://placehold.co/600x900/93c5fd/333?text=Article+1+Blue',
  },
  {
    sku: 'KDA-ART1-ORANGE',
    name: 'Article 1 — Orange Floral Pure Cotton Suit',
    description:
      'Pure cotton suit set with orange and yellow floral block print. Includes kurta, pants, and matching printed dupatta.',
    category: 'Suits',
    basePrice: 2270,
    imageUrl: 'https://placehold.co/600x900/fb923c/fff?text=Article+1+Orange',
  },
  {
    sku: 'KDA-ART4-TEAL',
    name: 'Article 4 — Teal Printed Cotton Suit',
    description:
      'Cotton suit set with teal printed dupatta featuring abstract botanical print. Includes kurta, pants, and dupatta.',
    category: 'Suits',
    basePrice: 1270,
    imageUrl: 'https://placehold.co/600x900/14b8a6/fff?text=Article+4+Teal',
  },
  {
    sku: 'KDA-ART4-PINK',
    name: 'Article 4 — Pink Printed Cotton Suit',
    description:
      'Cotton suit set with pink printed dupatta featuring abstract botanical print. Includes kurta, pants, and dupatta.',
    category: 'Suits',
    basePrice: 1270,
    imageUrl: 'https://placehold.co/600x900/ec4899/fff?text=Article+4+Pink',
  },
  {
    sku: 'KDA-RED-COORD-01',
    name: 'Red Printed Cotton Co-ord Set',
    description:
      'Bright red printed cotton shirt + matching wide-leg pant co-ord. Modern silhouette, pure cotton.',
    category: 'Suits',
    basePrice: 1800, // placeholder — image had no visible price
    imageUrl: 'https://placehold.co/600x900/dc2626/fff?text=Red+Coord',
  },
  {
    sku: 'KDA-WHITE-FLORAL-01',
    name: 'White Floral Embroidered Cotton Suit Set',
    description:
      'Off-white cotton kurta with blue rose embroidery, matching pants and contrast dupatta.',
    category: 'Suits',
    basePrice: 1900, // placeholder — image had no visible price
    imageUrl: 'https://placehold.co/600x900/f5f5f5/333?text=White+Floral',
  },
];

async function upsertProduct(p: ProductSpec): Promise<string> {
  const product = await prisma.product.upsert({
    where: { sku: p.sku },
    create: {
      sku: p.sku,
      name: p.name,
      description: p.description,
      category: p.category,
      basePrice: new Prisma.Decimal(p.basePrice),
      imageUrl: p.imageUrl,
      isActive: true,
    },
    update: {
      name: p.name,
      description: p.description,
      category: p.category,
      basePrice: new Prisma.Decimal(p.basePrice),
      imageUrl: p.imageUrl,
      isActive: true,
    },
  });
  return product.id;
}

async function upsertSizeVariant(productId: string, size: string): Promise<void> {
  // (productId, size, color) is uniquely constrained in the schema. With
  // color = null Prisma can't address the composite unique cleanly across
  // versions, so do find-or-create manually.
  const existing = await prisma.productVariant.findFirst({
    where: { productId, size, color: null },
  });
  if (existing) {
    await prisma.productVariant.update({
      where: { id: existing.id },
      data: { stock: STOCK_PER_SIZE },
    });
  } else {
    await prisma.productVariant.create({
      data: {
        productId,
        size,
        color: null,
        stock: STOCK_PER_SIZE,
      },
    });
  }
}

async function main(): Promise<void> {
  console.log(
    `Seeding ${PRODUCTS.length} products × ${SIZES.length} sizes (stock ${STOCK_PER_SIZE} each)…`,
  );

  for (const p of PRODUCTS) {
    const productId = await upsertProduct(p);
    for (const size of SIZES) {
      await upsertSizeVariant(productId, size);
    }
    console.log(`  ✓ ${p.sku.padEnd(22)} ₹${p.basePrice.toString().padStart(5)}  ${p.name}`);
  }

  const productCount = await prisma.product.count({ where: { isActive: true } });
  const variantCount = await prisma.productVariant.count();
  console.log(
    `\nDone. ${productCount} active products, ${variantCount} variants. Total units in stock: ${variantCount * STOCK_PER_SIZE}.`,
  );
  console.log('Next: open /inventory/[id] in the dashboard to upload the real images.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
