import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma, Prisma, StockMovementType } from '@kda/db';
import { requireAuth, requireOwner } from '../auth/middleware';
import { emitToDashboard } from '../realtime/io';
import { getStockMovementsForVariant, recordStockMovement } from '../chatbot/orderService';
import { env } from '../config/env';
import { deleteImage } from '../storage/cloudinary';
import { logger } from '../logger';
import { matchProduct } from '../ai/productMatcher';
import { productListStatusWhere, decideProductDeletion } from './productCrud';

export const productsRouter = Router();

const VariantInput = z.object({
  size: z.string().min(1).max(20),
  color: z.string().nullable().optional(),
  stock: z.number().int().nonnegative(),
  priceOverride: z.number().positive().nullable().optional(),
  isActive: z.boolean().optional(),
});

const OptionalName = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}, z.string().min(1).optional());

const CreateProductSchema = z.object({
  sku: z.string().min(1),
  name: OptionalName,
  description: z.string().default(''),
  category: z.string().min(1),
  categoryId: z.string().nullable().optional(),
  basePrice: z.number().positive(),
  imageUrl: z.string().min(1),
  imagePublicId: z.string().optional(),
  isActive: z.boolean().default(true),
  variants: z.array(VariantInput).default([]),
});

const UpdateProductSchema = CreateProductSchema.partial().omit({ variants: true });
const ImageMatchDiagnoseSchema = z.object({
  imageBase64: z.string().min(1),
  imageMediaType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']).optional(),
});

productsRouter.use(requireAuth);

// =============================================================================
// LIST
// =============================================================================

productsRouter.get('/products', async (req: Request, res: Response): Promise<void> => {
  const q = (req.query.q as string) ?? '';
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);
  // Active inventory by default. Archived (isActive=false / soft-deleted) products
  // must NOT appear in normal lists, the manual-receipt selector or matching.
  // `status=archived` returns only archived; `status=all` returns everything.
  const products = await prisma.product.findMany({
    where: {
      ...productListStatusWhere(req.query.status as string | undefined),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { sku: { contains: q, mode: 'insensitive' } },
              { category: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: { variants: { where: { isActive: true } }, categoryRecord: true },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({
    products: products.map((p) => ({
      ...p,
      basePrice: p.basePrice.toString(),
      categoryId: p.categoryId,
      categoryRecord: p.categoryRecord,
      variants: p.variants.map((v) => ({
        ...v,
        priceOverride: v.priceOverride?.toString() ?? null,
      })),
      totalStock: p.variants.reduce((s, v) => s + v.stock, 0),
    })),
  });
});

productsRouter.post('/products/image-match/diagnose', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = ImageMatchDiagnoseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  const outcome = await matchProduct(parsed.data);
  const secondScore = outcome.candidates.find((candidate) => candidate.productId !== outcome.matchedProductId)?.confidence ?? null;
  res.json({
    decision: outcome.decision,
    decisionReason: outcome.decisionReason,
    matchType: outcome.matchType,
    topScore: outcome.confidence,
    secondScore,
    scoreMargin: outcome.bestSecondMargin,
    thresholds: {
      match: env.IMAGE_MATCH_THRESHOLD,
      margin: env.IMAGE_MIN_SCORE_MARGIN,
      nearDuplicate: env.IMAGE_NEAR_DUPLICATE_THRESHOLD,
      nearDuplicatePHash: env.IMAGE_NEAR_DUPLICATE_PHASH_THRESHOLD,
      nearDuplicatePixel: env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD,
      nearDuplicateEdge: env.IMAGE_NEAR_DUPLICATE_EDGE_THRESHOLD,
      nearDuplicateFeature: env.IMAGE_NEAR_DUPLICATE_FEATURE_THRESHOLD,
    },
    candidates: outcome.candidates.slice(0, 5).map((candidate, index) => ({
      rank: index + 1,
      productId: candidate.productId,
      sku: candidate.sku,
      name: candidate.name,
      imageId: candidate.imageId,
      imageRef: candidate.imageRef,
      matchType: candidate.matchType,
      combinedScore: candidate.confidence,
      perceptualScore: candidate.perceptualHashSimilarity,
      structuralScore: candidate.structuralSimilarity,
      pixelScore: candidate.pixelSimilarity,
      colourPixelScore: candidate.colorPixelSimilarity,
      edgeScore: candidate.edgeSimilarity,
      embeddingScore: candidate.embeddingSimilarity,
      colourScore: candidate.colorSimilarity,
      averageHashSimilarity: candidate.averageHashSimilarity,
      differenceHashSimilarity: candidate.differenceHashSimilarity,
      nearDuplicateScore: candidate.nearDuplicateScore,
      generalScore: candidate.generalScore,
      scoreMargin: Math.max(candidate.confidence - (secondScore ?? 0), 0),
    })),
  });
});

// =============================================================================
// GET
// =============================================================================

productsRouter.get('/products/:id', async (req: Request, res: Response): Promise<void> => {
  const product = await prisma.product.findUnique({
    where: { id: (req.params.id as string) },
    include: { variants: { where: { isActive: true }, orderBy: { size: 'asc' } }, categoryRecord: true },
  });
  if (!product) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    product: {
      ...product,
      basePrice: product.basePrice.toString(),
      categoryId: product.categoryId,
      categoryRecord: product.categoryRecord,
      variants: product.variants.map((v) => ({
        ...v,
        priceOverride: v.priceOverride?.toString() ?? null,
      })),
    },
  });
});

// =============================================================================
// CREATE
// =============================================================================

productsRouter.post('/products', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const { variants, ...rest } = parsed.data;
  try {
    const product = await prisma.$transaction(async (tx) => {
      const categoryName = await resolveCategoryName(rest.categoryId ?? null, rest.category, tx);
      const created = await tx.product.create({
        data: {
          ...rest,
          category: categoryName,
          categoryId: rest.categoryId ?? null,
          name: rest.name ?? defaultProductName(rest.sku, categoryName),
          basePrice: new Prisma.Decimal(rest.basePrice),
          variants: {
            create: variants.map((v) => ({
              size: v.size,
              color: v.color ?? null,
              stock: v.stock,
              priceOverride: v.priceOverride ? new Prisma.Decimal(v.priceOverride) : null,
              isActive: v.isActive ?? true,
            })),
          },
        },
        include: { variants: true },
      });
      for (const variant of created.variants) {
        if (variant.stock === 0) continue;
        await recordStockMovement(
          {
            productVariantId: variant.id,
            type: StockMovementType.MANUAL_ADJUSTMENT,
            quantityChange: variant.stock,
            previousStock: 0,
            newStock: variant.stock,
            adminUserId: req.auth!.sub,
            note: 'Initial stock entered while creating product',
          },
          tx,
        );
      }
      return created;
    });
    emitToDashboard('inventory_changed', { productId: product.id });
    res.status(201).json({ productId: product.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'sku_exists' });
      return;
    }
    throw err;
  }
});

// =============================================================================
// UPDATE
// =============================================================================

productsRouter.put('/products/:id', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = UpdateProductSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const data: Prisma.ProductUpdateInput = { ...parsed.data };
  if (parsed.data.categoryId !== undefined || parsed.data.category !== undefined) {
    const categoryName = await resolveCategoryName(
      parsed.data.categoryId ?? null,
      parsed.data.category ?? undefined,
    );
    data.category = categoryName;
    data.categoryRecord = parsed.data.categoryId
      ? { connect: { id: parsed.data.categoryId } }
      : parsed.data.categoryId === null
        ? { disconnect: true }
        : undefined;
    delete (data as { categoryId?: unknown }).categoryId;
  }
  if (parsed.data.basePrice !== undefined) {
    data.basePrice = new Prisma.Decimal(parsed.data.basePrice);
  }
  // Capture the current Cloudinary asset so we can delete it if the photo is replaced.
  const before = await prisma.product.findUnique({
    where: { id: (req.params.id as string) },
    select: { imagePublicId: true, imageUrl: true },
  });
  const product = await prisma.product.update({
    where: { id: (req.params.id as string) },
    data,
  });
  const imageChanged =
    (parsed.data.imageUrl !== undefined && before?.imageUrl !== parsed.data.imageUrl) ||
    (parsed.data.imagePublicId !== undefined && before?.imagePublicId !== parsed.data.imagePublicId);
  if (imageChanged) {
    await prisma.productImageFeature.deleteMany({ where: { productId: product.id } });
  }
  // Replaced photo → remove the old remote asset (best-effort; never blocks the response).
  if (
    parsed.data.imagePublicId &&
    before?.imagePublicId &&
    before.imagePublicId !== parsed.data.imagePublicId
  ) {
    await safeDeleteImage(before.imagePublicId);
  }
  emitToDashboard('inventory_changed', { productId: product.id });
  res.json({ productId: product.id });
});

// =============================================================================
// DELETE — `?hard=true` tries a permanent delete; otherwise soft (isActive=false).
// Hard delete falls back to soft if any variant has been ordered (FK Restrict).
// =============================================================================

productsRouter.delete('/products/:id', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const hard = req.query.hard === 'true';

  const existing = await prisma.product.findUnique({
    where: { id },
    select: { id: true, imagePublicId: true, isActive: true },
  });
  if (!existing) {
    res.status(404).json({ ok: false, code: 'NOT_FOUND', message: 'Product not found' });
    return;
  }

  const references = await countProductReferences(id);
  const isReferenced = references.orders > 0 || references.receiptItems > 0;

  if (decideProductDeletion({ hard, isReferenced }) === 'deleted') {
    try {
      // Schema cascades variants on product delete; OrderItem/ManualReceiptItem/
      // StockMovement → variant are Restrict, so a still-referenced product throws P2003.
      await prisma.product.delete({ where: { id } });
      if (existing.imagePublicId) await safeDeleteImage(existing.imagePublicId);
      emitToDashboard('inventory_changed', { productId: id, deleted: 'hard' });
      res.json({ ok: true, action: 'deleted', mode: 'hard', id });
      return;
    } catch (err) {
      // Any remaining Restrict reference (e.g. stock movements) → archive instead.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2003') throw err;
    }
  }

  // Archive (soft delete): referenced product, or a non-hard request. Idempotent.
  await prisma.product.update({ where: { id }, data: { isActive: false } });
  await prisma.productImageFeature.deleteMany({ where: { productId: id } });
  emitToDashboard('inventory_changed', { productId: id, deleted: hard ? 'soft_fallback' : 'soft' });
  res.json({
    ok: true,
    action: 'archived',
    mode: hard ? 'soft_fallback' : 'soft',
    id,
    references,
    ...(hard ? { reason: 'product is used in existing orders/receipts — archived instead of deleted' } : {}),
  });
});

/** Count the history references that block a hard product delete. */
async function countProductReferences(productId: string): Promise<{ orders: number; receiptItems: number }> {
  const [orders, receiptItems] = await Promise.all([
    prisma.orderItem.count({ where: { variant: { productId } } }),
    prisma.manualReceiptItem.count({ where: { variant: { productId } } }),
  ]);
  return { orders, receiptItems };
}

// =============================================================================
// VARIANTS
// =============================================================================

productsRouter.post('/products/:id/variants', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = VariantInput.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const variant = await prisma.$transaction(async (tx) => {
      const existing = await tx.productVariant.findFirst({
        where: {
          productId: (req.params.id as string),
          size: parsed.data.size,
          color: parsed.data.color ?? null,
        },
      });
      if (existing && !existing.isActive) {
        const updated = await tx.productVariant.update({
          where: { id: existing.id },
          data: {
            stock: parsed.data.stock,
            priceOverride: parsed.data.priceOverride
              ? new Prisma.Decimal(parsed.data.priceOverride)
              : null,
            isActive: parsed.data.isActive ?? true,
          },
        });
        if (updated.stock !== existing.stock) {
          await recordStockMovement(
            {
              productVariantId: updated.id,
              type: StockMovementType.MANUAL_ADJUSTMENT,
              quantityChange: updated.stock - existing.stock,
              previousStock: existing.stock,
              newStock: updated.stock,
              adminUserId: req.auth!.sub,
              note: 'Stock adjusted while reactivating variant',
            },
            tx,
          );
        }
        return updated;
      }
      const created = await tx.productVariant.create({
        data: {
          productId: (req.params.id as string),
          size: parsed.data.size,
          color: parsed.data.color ?? null,
          stock: parsed.data.stock,
          priceOverride: parsed.data.priceOverride
            ? new Prisma.Decimal(parsed.data.priceOverride)
            : null,
          isActive: parsed.data.isActive ?? true,
        },
      });
      if (created.stock !== 0) {
        await recordStockMovement(
          {
            productVariantId: created.id,
            type: StockMovementType.MANUAL_ADJUSTMENT,
            quantityChange: created.stock,
            previousStock: 0,
            newStock: created.stock,
            adminUserId: req.auth!.sub,
            note: 'Initial stock entered while creating variant',
          },
          tx,
        );
      }
      return created;
    });
    emitToDashboard('inventory_changed', { productId: (req.params.id as string), variantId: variant.id });
    res.status(201).json({ variantId: variant.id });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      res.status(409).json({ error: 'variant_exists' });
      return;
    }
    throw err;
  }
});

productsRouter.put('/variants/:id', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = VariantInput.partial().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  const data: Prisma.ProductVariantUpdateInput = { ...parsed.data, color: parsed.data.color };
  if (parsed.data.priceOverride !== undefined) {
    data.priceOverride =
      parsed.data.priceOverride === null ? null : new Prisma.Decimal(parsed.data.priceOverride);
  }
  const v = await prisma.$transaction(async (tx) => {
    const before = await tx.productVariant.findUnique({
      where: { id: (req.params.id as string) },
      select: { id: true, stock: true },
    });
    if (!before) throw new Error('variant_not_found');
    const updated = await tx.productVariant.update({ where: { id: before.id }, data });
    if (parsed.data.stock !== undefined && parsed.data.stock !== before.stock) {
      await recordStockMovement(
        {
          productVariantId: before.id,
          type: StockMovementType.MANUAL_ADJUSTMENT,
          quantityChange: parsed.data.stock - before.stock,
          previousStock: before.stock,
          newStock: parsed.data.stock,
          adminUserId: req.auth!.sub,
          note: 'Manual stock adjustment from dashboard',
        },
        tx,
      );
    }
    return updated;
  });
  emitToDashboard('inventory_changed', { variantId: v.id });
  res.json({ variantId: v.id });
});

productsRouter.get('/variants/:id/stock-movements', async (req: Request, res: Response): Promise<void> => {
  const movements = await getStockMovementsForVariant(
    req.params.id as string,
    parseInt((req.query.limit as string) ?? '100', 10) || 100,
  );
  res.json({ movements });
});

productsRouter.delete('/variants/:id', requireOwner, async (req: Request, res: Response): Promise<void> => {
  const id = req.params.id as string;
  const usage = await prisma.$transaction(async (tx) => {
    const [orderItems, manualItems] = await Promise.all([
      tx.orderItem.count({ where: { productVariantId: id } }),
      tx.manualReceiptItem.count({ where: { productVariantId: id } }),
    ]);
    if (orderItems > 0 || manualItems > 0) {
      await tx.productVariant.update({ where: { id }, data: { isActive: false } });
      return 'soft' as const;
    }
    await tx.productVariant.delete({ where: { id } });
    return 'hard' as const;
  });
  emitToDashboard('inventory_changed', { variantId: id, deleted: usage });
  res.json({ ok: true, mode: usage });
});

function defaultProductName(sku: string, category: string): string {
  return `${category} ${sku}`.trim();
}

/**
 * Delete a Cloudinary asset, but only when Cloudinary is the active provider, and never
 * let a cleanup failure break the request — orphaned assets are preferable to 500s.
 */
async function safeDeleteImage(publicId: string): Promise<void> {
  if (env.UPLOAD_PROVIDER !== 'cloudinary') return;
  try {
    await deleteImage(publicId);
  } catch (err) {
    logger.warn({ err, publicId }, 'cloudinary asset delete failed (left orphaned)');
  }
}

async function resolveCategoryName(
  categoryId: string | null,
  fallbackCategory: string | undefined,
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string> {
  if (categoryId) {
    const category = await tx.category.findUnique({
      where: { id: categoryId },
      select: { name: true },
    });
    if (category) return category.name;
  }
  return (fallbackCategory ?? 'Stitched Suits').trim();
}
