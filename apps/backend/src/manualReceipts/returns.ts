import {
  ManualReceiptStatus,
  Prisma,
  ReceiptReturnStatus,
  RefundMethod,
  StockMovementType,
  prisma,
} from '@kda/db';
import type { ManualReceiptReturn } from '@kda/db';
import { recordStockMovement } from '../chatbot/orderService';

export interface ManualReceiptReturnItemInput {
  receiptItemId: string;
  quantity: number;
}

export interface CreateManualReceiptReturnInput {
  receiptId: string;
  createdById: string;
  reason: string;
  refundMethod: RefundMethod;
  notes?: string | null;
  items: ManualReceiptReturnItemInput[];
  requestId?: string | null;
}

export interface CreateManualReceiptReturnResult {
  returnRecord: ManualReceiptReturn;
  created: boolean;
}

interface ReceiptItemForReturn {
  id: string;
  productVariantId: string;
  quantity: number;
  unitPrice: Prisma.Decimal;
  variant: {
    product: {
      name: string;
      sku: string;
    };
  };
}

interface ExistingReturnItemForReturn {
  manualReceiptItemId: string;
  quantity: number;
}

interface ReceiptForReturn {
  id: string;
  receiptNumber: string;
  status: ManualReceiptStatus;
  discount: Prisma.Decimal;
  items: ReceiptItemForReturn[];
  returns: {
    status: ReceiptReturnStatus;
    items: ExistingReturnItemForReturn[];
  }[];
}

export interface ReturnLineCalculation {
  receiptItem: ReceiptItemForReturn;
  quantity: number;
  alreadyReturned: number;
  remainingBeforeReturn: number;
  grossAmount: Prisma.Decimal;
  discountShare: Prisma.Decimal;
  refundAmount: Prisma.Decimal;
}

export interface ReturnCalculation {
  lines: ReturnLineCalculation[];
  refundAmount: Prisma.Decimal;
  returnedQuantityAfter: number;
  soldQuantity: number;
  nextStatus: ManualReceiptStatus;
}

export async function createManualReceiptReturn(input: CreateManualReceiptReturnInput): Promise<CreateManualReceiptReturnResult | null> {
  const idempotencyKey = input.requestId ? `MANUAL_RECEIPT_RETURN:${input.receiptId}:${input.requestId}` : null;
  if (idempotencyKey) {
    const existing = await prisma.manualReceiptReturn.findUnique({ where: { idempotencyKey } });
    if (existing) return { returnRecord: existing, created: false };
  }

  try {
    return await prisma.$transaction(async (tx) => {
    const receipt = await tx.manualReceipt.findUnique({
      where: { id: input.receiptId },
      include: {
        items: {
          include: {
            variant: { include: { product: { select: { name: true, sku: true } } } },
          },
        },
        returns: {
          where: { status: ReceiptReturnStatus.COMPLETED },
          include: { items: true },
        },
      },
    });
    if (!receipt) return null;

    const calculation = calculateManualReceiptReturn(receipt, input.items, input.refundMethod);
    const returnRecord = await tx.manualReceiptReturn.create({
      data: {
        receiptId: receipt.id,
        status: ReceiptReturnStatus.COMPLETED,
        reason: input.reason.trim(),
        refundMethod: input.refundMethod,
        refundAmount: calculation.refundAmount,
        notes: input.notes?.trim() || null,
        idempotencyKey,
        createdById: input.createdById,
        items: {
          create: calculation.lines.map((line) => ({
            manualReceiptItemId: line.receiptItem.id,
            productVariantId: line.receiptItem.productVariantId,
            quantity: line.quantity,
            unitAmount: line.receiptItem.unitPrice,
            refundAmount: line.refundAmount,
          })),
        },
      },
    });

    for (const line of calculation.lines) {
      const variant = await tx.productVariant.update({
        where: { id: line.receiptItem.productVariantId },
        data: { stock: { increment: line.quantity } },
        select: { stock: true },
      });
      await recordStockMovement(
        {
          productVariantId: line.receiptItem.productVariantId,
          type: StockMovementType.MANUAL_RECEIPT_RETURN,
          quantityChange: line.quantity,
          previousStock: variant.stock - line.quantity,
          newStock: variant.stock,
          manualReceiptId: receipt.id,
          manualReceiptReturnId: returnRecord.id,
          adminUserId: input.createdById,
          note: `Manual receipt return ${returnRecord.id} for ${receipt.receiptNumber}`,
        },
        tx,
      );
    }

    await tx.manualReceipt.update({
      where: { id: receipt.id },
      data: { status: calculation.nextStatus },
    });

    await tx.auditLog.create({
      data: {
        action: 'MANUAL_RECEIPT_RETURN_CREATED',
        entityType: 'ManualReceiptReturn',
        entityId: returnRecord.id,
        actorUserId: input.createdById,
        payload: {
          receiptId: receipt.id,
          receiptNumber: receipt.receiptNumber,
          returnId: returnRecord.id,
          reason: input.reason,
          refundMethod: input.refundMethod,
          refundAmount: calculation.refundAmount.toString(),
          items: calculation.lines.map((line) => ({
            receiptItemId: line.receiptItem.id,
            productVariantId: line.receiptItem.productVariantId,
            quantity: line.quantity,
            refundAmount: line.refundAmount.toString(),
          })),
        },
      },
    });

    return { returnRecord, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (idempotencyKey && isUniqueConstraintError(err)) {
      const existing = await prisma.manualReceiptReturn.findUnique({ where: { idempotencyKey } });
      if (existing) return { returnRecord: existing, created: false };
    }
    throw err;
  }
}

export function calculateManualReceiptReturn(
  receipt: ReceiptForReturn,
  requestedItems: ManualReceiptReturnItemInput[],
  refundMethod: RefundMethod,
): ReturnCalculation {
  if (receipt.status === ManualReceiptStatus.VOIDED) {
    throw new ManualReceiptReturnError(409, 'receipt_voided');
  }

  if (!requestedItems.length) {
    throw new ManualReceiptReturnError(400, 'no_return_items');
  }

  const itemById = new Map(receipt.items.map((item) => [item.id, item]));
  const requestedByItemId = new Map<string, number>();
  for (const requested of requestedItems) {
    if (!Number.isInteger(requested.quantity) || requested.quantity <= 0) {
      throw new ManualReceiptReturnError(400, 'invalid_return_quantity');
    }
    requestedByItemId.set(requested.receiptItemId, (requestedByItemId.get(requested.receiptItemId) ?? 0) + requested.quantity);
  }

  const returnedByItemId = previouslyReturnedQuantityByItem(receipt);
  const soldQuantity = receipt.items.reduce((sum, item) => sum + item.quantity, 0);
  const totalGross = receipt.items.reduce(
    (sum, item) => sum.plus(item.unitPrice.mul(item.quantity)),
    new Prisma.Decimal(0),
  );
  const lines: ReturnLineCalculation[] = [];

  for (const [receiptItemId, quantity] of requestedByItemId.entries()) {
    const receiptItem = itemById.get(receiptItemId);
    if (!receiptItem) throw new ManualReceiptReturnError(400, 'return_item_not_in_receipt');
    const alreadyReturned = returnedByItemId.get(receiptItemId) ?? 0;
    const remainingBeforeReturn = receiptItem.quantity - alreadyReturned;
    if (quantity > remainingBeforeReturn) {
      throw new ManualReceiptReturnError(409, 'return_quantity_exceeds_remaining');
    }

    const grossAmount = receiptItem.unitPrice.mul(quantity);
    const discountShare = totalGross.gt(0)
      ? receipt.discount.mul(grossAmount).div(totalGross).toDecimalPlaces(2)
      : new Prisma.Decimal(0);
    const netRefund = grossAmount.minus(discountShare);
    const calculatedRefund = (netRefund.isNegative() ? new Prisma.Decimal(0) : netRefund).toDecimalPlaces(2);
    lines.push({
      receiptItem,
      quantity,
      alreadyReturned,
      remainingBeforeReturn,
      grossAmount,
      discountShare,
      refundAmount: refundMethod === RefundMethod.NO_REFUND ? new Prisma.Decimal(0) : calculatedRefund,
    });
  }

  const refundAmount = lines.reduce((sum, line) => sum.plus(line.refundAmount), new Prisma.Decimal(0)).toDecimalPlaces(2);
  const previousReturnedQuantity = Array.from(returnedByItemId.values()).reduce((sum, quantity) => sum + quantity, 0);
  const returnedQuantityAfter = previousReturnedQuantity + lines.reduce((sum, line) => sum + line.quantity, 0);
  const nextStatus = returnedQuantityAfter <= 0
    ? ManualReceiptStatus.ACTIVE
    : returnedQuantityAfter >= soldQuantity
      ? ManualReceiptStatus.RETURNED
      : ManualReceiptStatus.PARTIALLY_RETURNED;

  return { lines, refundAmount, returnedQuantityAfter, soldQuantity, nextStatus };
}

export function previouslyReturnedQuantityByItem(receipt: Pick<ReceiptForReturn, 'returns'>): Map<string, number> {
  const returnedByItemId = new Map<string, number>();
  for (const returnRecord of receipt.returns) {
    if (returnRecord.status !== ReceiptReturnStatus.COMPLETED) continue;
    for (const item of returnRecord.items) {
      returnedByItemId.set(
        item.manualReceiptItemId,
        (returnedByItemId.get(item.manualReceiptItemId) ?? 0) + item.quantity,
      );
    }
  }
  return returnedByItemId;
}

export class ManualReceiptReturnError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002',
  );
}
