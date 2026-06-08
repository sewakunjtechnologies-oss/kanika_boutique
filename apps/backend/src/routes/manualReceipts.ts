import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PaymentMode, Prisma, StockMovementType, prisma } from '@kda/db';
import { calculateDeliveryCharge } from '@kda/shared';
import { requireAuth, requireManagerOrOwner } from '../auth/middleware';
import { recordStockMovement } from '../chatbot/orderService';
import { emitToDashboard } from '../realtime/io';
import { printSource } from '../printing/printNodeClient';
import { logger } from '../logger';

export const manualReceiptsRouter = Router();
manualReceiptsRouter.use(requireAuth);

const ReceiptItemSchema = z.object({
  productVariantId: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
});

const CreateManualReceiptSchema = z.object({
  customerName: z.string().max(120).optional().nullable(),
  customerPhone: z.string().max(30).optional().nullable(),
  items: z.array(ReceiptItemSchema).min(1),
  deliveryCharge: z.number().nonnegative().optional().nullable(),
  discount: z.number().nonnegative().default(0),
  paymentMode: z.nativeEnum(PaymentMode),
  notes: z.string().max(1000).optional().nullable(),
});

manualReceiptsRouter.get('/manual-receipts', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);
  const receipts = await prisma.manualReceipt.findMany({
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      items: { select: { quantity: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  res.json({
    receipts: receipts.map((receipt) => ({
      ...receipt,
      subtotal: receipt.subtotal.toString(),
      deliveryCharge: receipt.deliveryCharge.toString(),
      discount: receipt.discount.toString(),
      totalAmount: receipt.totalAmount.toString(),
      itemCount: receipt.items.reduce((sum, item) => sum + item.quantity, 0),
    })),
  });
});

manualReceiptsRouter.get('/manual-receipts/:id', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const receipt = await prisma.manualReceipt.findUnique({
    where: { id: req.params.id as string },
    include: {
      createdBy: { select: { id: true, name: true, email: true } },
      items: {
        include: {
          variant: {
            include: { product: { select: { id: true, sku: true, name: true, imageUrl: true } } },
          },
        },
      },
    },
  });
  if (!receipt) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    receipt: {
      ...receipt,
      subtotal: receipt.subtotal.toString(),
      deliveryCharge: receipt.deliveryCharge.toString(),
      discount: receipt.discount.toString(),
      totalAmount: receipt.totalAmount.toString(),
      items: receipt.items.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toString(),
        variant: {
          ...item.variant,
          priceOverride: item.variant.priceOverride?.toString() ?? null,
        },
      })),
    },
  });
});

manualReceiptsRouter.post('/manual-receipts', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = CreateManualReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  const createdById = req.auth!.sub;
  const items = parsed.data.items;
  const totalQty = items.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  const deliveryCharge = parsed.data.deliveryCharge ?? calculateDeliveryCharge(totalQty);
  const discount = parsed.data.discount ?? 0;
  const totalAmount = Math.max(subtotal + deliveryCharge - discount, 0);

  try {
    const receipt = await prisma.$transaction(async (tx) => {
      const receiptNumber = await nextManualReceiptNumber(tx);
      const created = await tx.manualReceipt.create({
        data: {
          receiptNumber,
          customerName: parsed.data.customerName?.trim() || null,
          customerPhone: parsed.data.customerPhone?.trim() || null,
          subtotal: new Prisma.Decimal(subtotal),
          deliveryCharge: new Prisma.Decimal(deliveryCharge),
          discount: new Prisma.Decimal(discount),
          totalAmount: new Prisma.Decimal(totalAmount),
          paymentMode: parsed.data.paymentMode,
          notes: parsed.data.notes?.trim() || null,
          createdById,
          items: {
            create: items.map((item) => ({
              productVariantId: item.productVariantId,
              quantity: item.quantity,
              unitPrice: new Prisma.Decimal(item.unitPrice),
            })),
          },
        },
        include: { items: true },
      });

      for (const item of items) {
        const updated = await tx.productVariant.updateMany({
          where: { id: item.productVariantId, isActive: true, stock: { gte: item.quantity } },
          data: { stock: { decrement: item.quantity } },
        });
        if (updated.count !== 1) throw new ReceiptRouteError(409, 'insufficient_stock');
        const variant = await tx.productVariant.findUnique({
          where: { id: item.productVariantId },
          select: { stock: true },
        });
        if (!variant) throw new ReceiptRouteError(409, 'missing_variant');
        await recordStockMovement(
          {
            productVariantId: item.productVariantId,
            type: StockMovementType.MANUAL_RECEIPT_DEDUCTION,
            quantityChange: -item.quantity,
            previousStock: variant.stock + item.quantity,
            newStock: variant.stock,
            manualReceiptId: created.id,
            adminUserId: createdById,
            note: `Manual receipt ${receiptNumber}`,
          },
          tx,
        );
      }

      return created;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    emitToDashboard('inventory_changed', { manualReceiptId: receipt.id });
    res.status(201).json({ receiptId: receipt.id, receiptNumber: receipt.receiptNumber });
  } catch (err) {
    if (err instanceof ReceiptRouteError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    logger.error({ err }, 'manual receipt create failed');
    res.status(500).json({ error: 'receipt_create_failed' });
  }
});

manualReceiptsRouter.post('/manual-receipts/:id/print', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  try {
    const printResult = await printSource({ sourceType: 'MANUAL_RECEIPT', sourceId: req.params.id as string });
    await prisma.manualReceipt.update({
      where: { id: req.params.id as string },
      data: { printedAt: new Date() },
    });
    res.json(printResult);
  } catch (err) {
    logger.error({ err, manualReceiptId: req.params.id }, 'manual receipt print failed');
    res.status(500).json({ error: 'print_failed' });
  }
});

async function nextManualReceiptNumber(tx: Prisma.TransactionClient = prisma): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `MR-${year}-`;
  const last = await tx.manualReceipt.findFirst({
    where: { receiptNumber: { startsWith: prefix } },
    orderBy: { receiptNumber: 'desc' },
    select: { receiptNumber: true },
  });
  let seq = 1;
  if (last) {
    const match = last.receiptNumber.match(/-(\d+)$/);
    if (match?.[1]) seq = Number.parseInt(match[1], 10) + 1;
  }
  return `${prefix}${seq.toString().padStart(4, '0')}`;
}

class ReceiptRouteError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
