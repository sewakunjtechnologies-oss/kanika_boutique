import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PaymentMode, Prisma, ReceiptReturnStatus, RefundMethod, StockMovementType, prisma } from '@kda/db';
import { calculateDeliveryCharge } from '@kda/shared';
import { requireAuth, requireManagerOrOwner } from '../auth/middleware';
import { recordStockMovement } from '../chatbot/orderService';
import { emitToDashboard } from '../realtime/io';
import {
  createManualReceiptInitialSlipJob,
  createManualReceiptReprintSlipJob,
  createManualReceiptReturnSlipJob,
  getManualReceiptPrintJobs,
} from '../printing/printJobs';
import { createManualReceiptReturn, ManualReceiptReturnError } from '../manualReceipts/returns';
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

const ReprintManualReceiptSchema = z.object({
  requestId: z.string().min(1).max(120).optional(),
});

const ReturnManualReceiptSchema = z.object({
  reason: z.string().min(3).max(500),
  refundMethod: z.nativeEnum(RefundMethod),
  notes: z.string().max(1000).optional().nullable(),
  requestId: z.string().min(1).max(120).optional(),
  items: z.array(z.object({
    receiptItemId: z.string().min(1),
    quantity: z.number().int().positive(),
  })).min(1),
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
          returnItems: {
            where: { return: { status: ReceiptReturnStatus.COMPLETED } },
            select: { quantity: true },
          },
        },
      },
      returns: {
        include: {
          createdBy: { select: { id: true, name: true, email: true } },
          items: {
            include: {
              receiptItem: {
                include: {
                  variant: { include: { product: { select: { id: true, sku: true, name: true } } } },
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
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
      status: receipt.status,
      items: receipt.items.map((item) => ({
        ...item,
        unitPrice: item.unitPrice.toString(),
        returnedQuantity: item.returnItems.reduce((sum, returnItem) => sum + returnItem.quantity, 0),
        variant: {
          ...item.variant,
          priceOverride: item.variant.priceOverride?.toString() ?? null,
        },
      })),
      returns: receipt.returns.map((returnRecord) => ({
        ...returnRecord,
        refundAmount: returnRecord.refundAmount.toString(),
        items: returnRecord.items.map((item) => ({
          ...item,
          unitAmount: item.unitAmount.toString(),
          refundAmount: item.refundAmount.toString(),
        })),
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
    const result = await createManualReceiptInitialSlipJob({
      receiptId: req.params.id as string,
      requestedBy: req.auth!.sub,
    });
    if (!result) {
      res.status(404).json({ error: 'receipt_not_found' });
      return;
    }
    emitToDashboard('printer_status_changed', {
      pendingJobId: result.job.id,
      manualReceiptId: req.params.id,
      created: result.created,
    });
    res.status(result.created ? 201 : 200).json({
      ok: true,
      printJobId: result.job.id,
      status: result.job.status,
      created: result.created,
      message: result.created ? 'Print job created' : 'Initial print job already exists',
    });
  } catch (err) {
    const errorId = `print_${Date.now().toString(36)}`;
    logger.error({ err, manualReceiptId: req.params.id, errorId }, 'manual receipt print failed');
    res.status(500).json({ error: 'manual_receipt_print_failed', errorId });
  }
});

manualReceiptsRouter.post('/manual-receipts/:id/reprint', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = ReprintManualReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const result = await createManualReceiptReprintSlipJob({
      receiptId: req.params.id as string,
      requestedBy: req.auth!.sub,
      requestId: parsed.data.requestId,
    });
    if (!result) {
      res.status(404).json({ error: 'receipt_not_found' });
      return;
    }
    emitToDashboard('printer_status_changed', {
      pendingJobId: result.job.id,
      manualReceiptId: req.params.id,
      created: result.created,
      reprint: true,
    });
    res.status(result.created ? 201 : 200).json({
      ok: true,
      printJobId: result.job.id,
      status: result.job.status,
      created: result.created,
      reprintNumber: result.reprintNumber,
      message: result.created ? 'Reprint job created' : 'Reprint job already exists',
    });
  } catch (err) {
    const errorId = `reprint_${Date.now().toString(36)}`;
    logger.error({ err, manualReceiptId: req.params.id, errorId }, 'manual receipt reprint failed');
    res.status(500).json({ error: 'manual_receipt_reprint_failed', errorId });
  }
});

manualReceiptsRouter.get('/manual-receipts/:id/print-jobs', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const receipt = await prisma.manualReceipt.findUnique({ where: { id: req.params.id as string }, select: { id: true } });
  if (!receipt) {
    res.status(404).json({ error: 'receipt_not_found' });
    return;
  }
  const jobs = await getManualReceiptPrintJobs(receipt.id);
  res.json({
    jobs: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      createdAt: job.createdAt,
      printedAt: job.printedAt,
      lastError: job.lastError,
      idempotencyKey: job.idempotencyKey,
      requestedBy: printMetadata(job.payload).requestedBy ?? null,
      requestedAt: printMetadata(job.payload).requestedAt ?? null,
      reprint: Boolean(printMetadata(job.payload).reprint),
      reprintNumber: printMetadata(job.payload).reprintNumber ?? (job.idempotencyKey.endsWith(':INITIAL') ? 1 : null),
    })),
  });
});

manualReceiptsRouter.post('/manual-receipts/:id/return', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  const parsed = ReturnManualReceiptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }

  try {
    const result = await createManualReceiptReturn({
      receiptId: req.params.id as string,
      createdById: req.auth!.sub,
      reason: parsed.data.reason,
      refundMethod: parsed.data.refundMethod,
      notes: parsed.data.notes,
      requestId: parsed.data.requestId,
      items: parsed.data.items,
    });
    if (!result) {
      res.status(404).json({ error: 'receipt_not_found' });
      return;
    }
    emitToDashboard('inventory_changed', { manualReceiptId: req.params.id, returnId: result.returnRecord.id });
    res.status(result.created ? 201 : 200).json({
      ok: true,
      returnId: result.returnRecord.id,
      created: result.created,
      refundAmount: result.returnRecord.refundAmount.toString(),
      status: result.returnRecord.status,
    });
  } catch (err) {
    if (err instanceof ManualReceiptReturnError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    const errorId = `return_${Date.now().toString(36)}`;
    logger.error({ err, manualReceiptId: req.params.id, errorId }, 'manual receipt return failed');
    res.status(500).json({ error: 'manual_receipt_return_failed', errorId });
  }
});

manualReceiptsRouter.post('/manual-receipts/:receiptId/returns/:returnId/print', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  await queueReturnSlip(req, res, false);
});

manualReceiptsRouter.post('/manual-receipts/:receiptId/returns/:returnId/reprint', requireManagerOrOwner, async (req: Request, res: Response): Promise<void> => {
  await queueReturnSlip(req, res, true);
});

async function queueReturnSlip(req: Request, res: Response, reprint: boolean): Promise<void> {
  const parsed = ReprintManualReceiptSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_input', fields: parsed.error.flatten().fieldErrors });
    return;
  }
  try {
    const result = await createManualReceiptReturnSlipJob({
      receiptId: req.params.receiptId as string,
      returnId: req.params.returnId as string,
      requestedBy: req.auth!.sub,
      reprint,
      requestId: parsed.data.requestId,
    });
    if (!result) {
      res.status(404).json({ error: 'return_not_found' });
      return;
    }
    emitToDashboard('printer_status_changed', {
      pendingJobId: result.job.id,
      manualReceiptId: req.params.receiptId,
      returnId: req.params.returnId,
      created: result.created,
      reprint,
    });
    res.status(result.created ? 201 : 200).json({
      ok: true,
      printJobId: result.job.id,
      status: result.job.status,
      created: result.created,
      reprintNumber: result.reprintNumber,
      message: result.created ? (reprint ? 'Return slip reprint job created' : 'Return slip print job created') : 'Return slip print job already exists',
    });
  } catch (err) {
    const errorId = `return_print_${Date.now().toString(36)}`;
    logger.error({ err, receiptId: req.params.receiptId, returnId: req.params.returnId, errorId }, 'manual receipt return slip print failed');
    res.status(500).json({ error: 'manual_receipt_return_slip_print_failed', errorId });
  }
}

function printMetadata(payload: Prisma.JsonValue): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const metadata = (payload as Record<string, unknown>).printMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return metadata as Record<string, unknown>;
}

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
