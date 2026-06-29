import { randomUUID } from 'node:crypto';
import {
  prisma,
  OrderStatus,
  PrintJobStatus,
  PrintJobType,
} from '@kda/db';
import {
  autoOrderLabelIdempotencyKey,
  reprintOrderLabelIdempotencyKey,
  maskPhone,
  parseLabelPayload,
  parseManualReceiptReturnSlipPayload,
  parseOfflineCustomerSlipPayload,
} from '@kda/labels';
import type { Prisma, PrintJob } from '@kda/db';
import type { LabelPayload, ManualReceiptReturnSlipPayload, OfflineCustomerSlipPayload } from '@kda/labels';
import { env } from '../config/env';
import { displaySizeFor, resolveProductSizeMode } from '../chatbot/sizeMode';

type Tx = Prisma.TransactionClient;

interface OrderForLabel {
  id: string;
  orderNumber: string;
  createdAt: Date;
  shippingName: string;
  shippingAddress: string;
  shippingCity: string;
  shippingState: string;
  shippingPincode: string;
  subtotal: { toString(): string };
  shippingFee: { toString(): string };
  totalAmount: { toString(): string };
  paymentExtractedUtr: string | null;
  paymentScreenshotUrl: string | null;
  customer: { whatsappNumber: string };
  items: {
    quantity: number;
    unitPrice: { toString(): string };
    variant: {
      size: string;
      product: {
        name: string;
        sku: string;
        category: string;
      };
    };
  }[];
}

interface ManualReceiptForSlip {
  id: string;
  receiptNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: { toString(): string };
  deliveryCharge: { toString(): string };
  discount: { toString(): string };
  totalAmount: { toString(): string };
  paymentMode: string;
  createdAt: Date;
  items: {
    quantity: number;
    unitPrice: { toString(): string };
    variant: {
      size: string;
      product: {
        name: string;
        sku: string;
      };
    };
  }[];
}

interface ManualReceiptReturnForSlip {
  id: string;
  reason: string;
  refundMethod: string;
  refundAmount: { toString(): string };
  createdAt: Date;
  receipt: {
    id: string;
    receiptNumber: string;
    customerName: string | null;
    customerPhone: string | null;
  };
  items: {
    quantity: number;
    refundAmount: { toString(): string };
    receiptItem: {
      unitPrice: { toString(): string };
      variant: {
        size: string;
        product: {
          name: string;
          sku: string;
        };
      };
    };
  }[];
}

export interface PrintJobCreateResult {
  job: PrintJob;
  created: boolean;
  reprintNumber?: number;
}

export async function createAutomaticOrderLabelJob(tx: Tx, orderId: string): Promise<PrintJob | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { whatsappNumber: true } },
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true, category: true } } } },
        },
      },
    },
  });
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.status !== OrderStatus.VERIFIED && order.status !== OrderStatus.PRINTED) return null;

  const idempotencyKey = autoOrderLabelIdempotencyKey(order.id);
  const payload = buildOrderLabelPayload(order);
  return tx.printJob.upsert({
    where: { idempotencyKey },
    create: {
      orderId: order.id,
      type: PrintJobType.ORDER_LABEL,
      status: PrintJobStatus.PENDING,
      payload: payload as never,
      idempotencyKey,
    },
    update: {},
  });
}

export async function createManualOrderLabelJob(orderId: string, requestedBy: string): Promise<PrintJob> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { whatsappNumber: true } },
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true, category: true } } } },
        },
      },
    },
  });
  if (!order) throw new Error(`order ${orderId} not found`);
  const payload = buildOrderLabelPayload(order);
  return prisma.printJob.create({
    data: {
      orderId: order.id,
      type: PrintJobType.ORDER_LABEL,
      status: PrintJobStatus.PENDING,
      payload: payload as never,
      // Intentional reprint — always a fresh, unique job, separate from the
      // automatic PAYMENT_APPROVED:INITIAL label.
      idempotencyKey: reprintOrderLabelIdempotencyKey(order.id, `${requestedBy}:${randomUUID()}`),
    },
  });
}

export async function createTestLabelJob(requestedBy = 'print-agent'): Promise<PrintJob> {
  const payload: LabelPayload = {
    templateVersion: 'test-label-v1',
    storeName: env.BUSINESS_NAME,
    orderId: 'KD-TEST-1001',
    createdAt: new Date().toISOString(),
    customerName: 'Priya Sharma',
    maskedPhone: '98XXXXXX21',
    phoneMasked: '98XXXXXX21',
    addressLine1: 'H.No. 25, Sector 14',
    addressLine2: 'Near Main Market',
    city: 'Sonipat',
    state: 'Haryana',
    pincode: '131001',
    productName: 'Pure Cotton Suit With Long Name',
    sku: 'KD-PCS-101',
    size: '40',
    quantity: 1,
    items: [
      {
        name: 'Pure Cotton Suit With Long Name',
        sku: 'KD-PCS-101',
        size: '40',
        quantity: 1,
        unitPrice: 2270,
        amount: 2270,
      },
    ],
    subtotal: 2270,
    deliveryCharge: 100,
    discount: 0,
    grandTotal: 2370,
    paymentType: 'UPI',
    paymentStatus: 'PAID',
    amount: 2370,
    barcodeValue: 'KD-TEST-1001',
    addressLine: 'H.No. 25, Sector 14',
  };

  return prisma.printJob.create({
    data: {
      type: PrintJobType.TEST_LABEL,
      status: PrintJobStatus.PENDING,
      payload: payload as never,
      idempotencyKey: `TEST_LABEL:${requestedBy}:${Date.now()}`,
    },
  });
}

export async function createManualReceiptSlipJob(input: {
  receiptId: string;
  requestedBy: string;
  reprint?: boolean;
  requestId?: string | null;
}): Promise<PrintJobCreateResult | null> {
  if (input.reprint) {
    return createManualReceiptReprintSlipJob(input);
  }
  return createManualReceiptInitialSlipJob(input);
}

export async function createManualReceiptInitialSlipJob(input: {
  receiptId: string;
  requestedBy: string;
}): Promise<PrintJobCreateResult | null> {
  const receipt = await prisma.manualReceipt.findUnique({
    where: { id: input.receiptId },
    include: {
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true } } } },
        },
      },
    },
  });
  if (!receipt) return null;

  const payload = buildManualReceiptSlipPayload(receipt);
  const idempotencyKey = `MANUAL_RECEIPT:${receipt.id}:INITIAL`;

  const existing = await prisma.printJob.findUnique({ where: { idempotencyKey } });
  if (existing) return { job: existing, created: false };

  try {
    const job = await prisma.printJob.create({
      data: {
        type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
        status: PrintJobStatus.PENDING,
        payload: withPrintMetadata(payload, {
          reprint: false,
          reprintNumber: 1,
          requestedBy: input.requestedBy,
          requestedAt: new Date().toISOString(),
          originalReceiptId: receipt.id,
        }) as never,
        idempotencyKey,
      },
    });
    return { job, created: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const job = await prisma.printJob.findUnique({ where: { idempotencyKey } });
      if (job) return { job, created: false };
    }
    throw err;
  }
}

export async function createManualReceiptReprintSlipJob(input: {
  receiptId: string;
  requestedBy: string;
  requestId?: string | null;
}): Promise<PrintJobCreateResult | null> {
  const receipt = await prisma.manualReceipt.findUnique({
    where: { id: input.receiptId },
    include: {
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true } } } },
        },
      },
    },
  });
  if (!receipt) return null;

  const reprintNumber = await nextManualReceiptReprintNumber(receipt.id);
  const idempotencyKey = input.requestId
    ? `MANUAL_RECEIPT:${receipt.id}:REPRINT:${input.requestId}`
    : `MANUAL_RECEIPT:${receipt.id}:REPRINT:${randomUUID()}`;
  const existing = await prisma.printJob.findUnique({ where: { idempotencyKey } });
  if (existing) return { job: existing, created: false, reprintNumber: existingReprintNumber(existing, reprintNumber) };

  const payload = buildManualReceiptSlipPayload(receipt);
  try {
    const job = await prisma.printJob.create({
      data: {
        type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
        status: PrintJobStatus.PENDING,
        payload: withPrintMetadata(payload, {
          reprint: true,
          reprintNumber,
          requestedBy: input.requestedBy,
          requestedAt: new Date().toISOString(),
          originalReceiptId: receipt.id,
        }) as never,
        idempotencyKey,
      },
    });
    return { job, created: true, reprintNumber };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const job = await prisma.printJob.findUnique({ where: { idempotencyKey } });
      if (job) return { job, created: false, reprintNumber: existingReprintNumber(job, reprintNumber) };
    }
    throw err;
  }
}

export async function createManualReceiptReturnSlipJob(input: {
  receiptId: string;
  returnId: string;
  requestedBy: string;
  reprint?: boolean;
  requestId?: string | null;
}): Promise<PrintJobCreateResult | null> {
  const returnRecord = await prisma.manualReceiptReturn.findFirst({
    where: { id: input.returnId, receiptId: input.receiptId },
    include: {
      receipt: { select: { id: true, receiptNumber: true, customerName: true, customerPhone: true } },
      items: {
        include: {
          receiptItem: {
            include: {
              variant: { include: { product: { select: { name: true, sku: true } } } },
            },
          },
        },
      },
    },
  });
  if (!returnRecord) return null;

  const reprintNumber = input.reprint ? await nextManualReturnSlipReprintNumber(input.returnId) : 1;
  const idempotencyKey = input.reprint
    ? input.requestId
      ? `MANUAL_RECEIPT_RETURN:${input.returnId}:REPRINT:${input.requestId}`
      : `MANUAL_RECEIPT_RETURN:${input.returnId}:REPRINT:${randomUUID()}`
    : `MANUAL_RECEIPT_RETURN:${input.returnId}:INITIAL`;
  const existing = await prisma.printJob.findUnique({ where: { idempotencyKey } });
  if (existing) return { job: existing, created: false, reprintNumber: existingReprintNumber(existing, reprintNumber) };

  const payload = buildManualReceiptReturnSlipPayload(returnRecord);
  try {
    const job = await prisma.printJob.create({
      data: {
        type: PrintJobType.OFFLINE_RETURN_SLIP,
        status: PrintJobStatus.PENDING,
        payload: withPrintMetadata(payload, {
          reprint: Boolean(input.reprint),
          reprintNumber,
          requestedBy: input.requestedBy,
          requestedAt: new Date().toISOString(),
          originalReceiptId: input.receiptId,
          originalReturnId: input.returnId,
        }) as never,
        idempotencyKey,
      },
    });
    return { job, created: true, reprintNumber };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const job = await prisma.printJob.findUnique({ where: { idempotencyKey } });
      if (job) return { job, created: false, reprintNumber: existingReprintNumber(job, reprintNumber) };
    }
    throw err;
  }
}

export async function getManualReceiptPrintJobs(receiptId: string): Promise<PrintJob[]> {
  return prisma.printJob.findMany({
    where: {
      idempotencyKey: { startsWith: `MANUAL_RECEIPT:${receiptId}:` },
      type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
    },
    orderBy: { createdAt: 'asc' },
  });
}

export async function claimNextPrintJob(deviceId: string): Promise<PrintJob | null> {
  const timeoutDate = new Date(Date.now() - env.PRINT_JOB_CLAIM_TIMEOUT_SECONDS * 1000);

  return prisma.$transaction(async (tx) => {
    await tx.printJob.updateMany({
      where: {
        status: { in: [PrintJobStatus.CLAIMED, PrintJobStatus.PRINTING] },
        claimedAt: { lt: timeoutDate },
        attempts: { lt: env.PRINT_JOB_MAX_ATTEMPTS },
      },
      data: {
        status: PrintJobStatus.PENDING,
        claimedAt: null,
        claimedBy: null,
        lastError: 'Claim timed out and was returned to pending.',
      },
    });

    const job = await tx.printJob.findFirst({
      where: {
        status: PrintJobStatus.PENDING,
        attempts: { lt: env.PRINT_JOB_MAX_ATTEMPTS },
      },
      orderBy: [{ createdAt: 'asc' }],
    });
    if (!job) return null;

    const claimed = await tx.printJob.updateMany({
      where: {
        id: job.id,
        status: PrintJobStatus.PENDING,
        attempts: { lt: env.PRINT_JOB_MAX_ATTEMPTS },
      },
      data: {
        status: PrintJobStatus.CLAIMED,
        claimedAt: new Date(),
        claimedBy: deviceId,
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (claimed.count !== 1) return null;
    return tx.printJob.findUnique({ where: { id: job.id } });
  });
}

export async function markPrintJobPrinting(id: string, deviceId: string): Promise<PrintJob | null> {
  const result = await prisma.printJob.updateMany({
    where: { id, claimedBy: deviceId, status: PrintJobStatus.CLAIMED },
    data: { status: PrintJobStatus.PRINTING },
  });
  if (result.count !== 1) return null;
  return prisma.printJob.findUnique({ where: { id } });
}

export async function markPrintJobPrinted(id: string, deviceId: string): Promise<PrintJob | null> {
  const result = await prisma.printJob.updateMany({
    where: {
      id,
      claimedBy: deviceId,
      status: { in: [PrintJobStatus.CLAIMED, PrintJobStatus.PRINTING] },
    },
    data: {
      status: PrintJobStatus.PRINTED,
      printedAt: new Date(),
      lastError: null,
    },
  });
  if (result.count !== 1) return null;
  const job = await prisma.printJob.findUnique({ where: { id } });
  if (job?.orderId && job.type === PrintJobType.ORDER_LABEL) {
    await prisma.order.update({
      where: { id: job.orderId },
      data: { status: OrderStatus.PRINTED, printedAt: new Date() },
    });
  }
  if (job?.type === PrintJobType.OFFLINE_CUSTOMER_SLIP) {
    const payload = parseOfflineCustomerSlipPayload(job.payload);
    await prisma.manualReceipt.updateMany({
      where: { receiptNumber: payload.receiptId },
      data: { printedAt: new Date() },
    });
  }
  return job;
}

export async function markPrintJobDryRunCompleted(id: string, deviceId: string): Promise<PrintJob | null> {
  const result = await prisma.printJob.updateMany({
    where: {
      id,
      claimedBy: deviceId,
      status: { in: [PrintJobStatus.CLAIMED, PrintJobStatus.PRINTING] },
    },
    data: {
      status: PrintJobStatus.DRY_RUN_COMPLETED,
      lastError: null,
    },
  });
  if (result.count !== 1) return null;
  return prisma.printJob.findUnique({ where: { id } });
}

export async function markPrintJobFailed(id: string, deviceId: string, error: string): Promise<PrintJob | null> {
  const result = await prisma.printJob.updateMany({
    where: {
      id,
      claimedBy: deviceId,
      status: { in: [PrintJobStatus.CLAIMED, PrintJobStatus.PRINTING] },
    },
    data: {
      status: PrintJobStatus.FAILED,
      lastError: error.slice(0, 1000),
    },
  });
  if (result.count !== 1) return null;
  return prisma.printJob.findUnique({ where: { id } });
}

export async function retryOldestFailedPrintJob(requestedBy: string): Promise<PrintJob | null> {
  return prisma.$transaction(async (tx) => {
    const job = await tx.printJob.findFirst({
      where: {
        status: PrintJobStatus.FAILED,
        attempts: { lt: env.PRINT_JOB_MAX_ATTEMPTS },
      },
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    });
    if (!job) return null;

    const result = await tx.printJob.updateMany({
      where: {
        id: job.id,
        status: PrintJobStatus.FAILED,
        attempts: { lt: env.PRINT_JOB_MAX_ATTEMPTS },
      },
      data: {
        status: PrintJobStatus.PENDING,
        claimedAt: null,
        claimedBy: null,
        lastError: `Retry requested by ${requestedBy}`,
      },
    });
    if (result.count !== 1) return null;
    return tx.printJob.findUnique({ where: { id: job.id } });
  });
}

export async function cancelPendingTestLabelJobs(adminUserId: string): Promise<number> {
  const result = await prisma.printJob.updateMany({
    where: {
      type: PrintJobType.TEST_LABEL,
      status: PrintJobStatus.PENDING,
    },
    data: {
      status: PrintJobStatus.CANCELLED,
      lastError: `Cancelled pending test labels by ${adminUserId}`,
    },
  });
  return result.count;
}

export function parsePrintJobPayload(job: Pick<PrintJob, 'payload'>): LabelPayload {
  return parseLabelPayload(job.payload);
}

export function parseOfflineSlipPrintJobPayload(job: Pick<PrintJob, 'payload'>): OfflineCustomerSlipPayload {
  return parseOfflineCustomerSlipPayload(job.payload);
}

export function parseManualReturnSlipPrintJobPayload(job: Pick<PrintJob, 'payload'>): ManualReceiptReturnSlipPayload {
  return parseManualReceiptReturnSlipPayload(job.payload);
}

export function buildOrderLabelPayload(order: OrderForLabel): LabelPayload {
  const firstItem = order.items[0];
  // Free-size (unstitched) orders attach to a real backing variant whose size may
  // be a legacy numeric label. The receipt must always read "Free Size", never the
  // numeric backing size — resolved authoritatively from the product category.
  const labelSize = (item: OrderForLabel['items'][number]): string =>
    displaySizeFor(resolveProductSizeMode({ category: item.variant.product.category }).sizeMode, item.variant.size);
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const productSuffix = order.items.length > 1 ? ` +${order.items.length - 1} more` : '';
  const productName = firstItem ? `${firstItem.variant.product.name}${productSuffix}` : 'Order item';
  const address = splitShippingAddress(order.shippingAddress);
  const phoneMasked = maskPhone(order.customer.whatsappNumber);
  const subtotal = moneyNumber(order.subtotal);
  const deliveryCharge = moneyNumber(order.shippingFee);
  const discount = 0;
  const grandTotal = moneyNumber(order.totalAmount);

  return {
    templateVersion: 'online-order-label-v1',
    storeName: env.BUSINESS_NAME,
    orderId: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    customerName: order.shippingName,
    maskedPhone: phoneMasked,
    phoneMasked,
    pincode: order.shippingPincode,
    productName,
    sku: firstItem?.variant.product.sku ?? '-',
    size: firstItem ? labelSize(firstItem) : '-',
    quantity,
    items: order.items.map((item) => ({
      name: item.variant.product.name,
      sku: item.variant.product.sku,
      size: labelSize(item),
      quantity: item.quantity,
      unitPrice: moneyNumber(item.unitPrice),
      amount: moneyNumber(item.unitPrice) * item.quantity,
    })),
    subtotal,
    deliveryCharge,
    discount,
    grandTotal,
    paymentType: 'UPI',
    paymentStatus: 'PAID',
    amount: grandTotal,
    barcodeValue: order.orderNumber,
    addressLine: address.addressLine1,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: order.shippingCity,
    state: order.shippingState,
  };
}

export function buildManualReceiptSlipPayload(receipt: ManualReceiptForSlip): OfflineCustomerSlipPayload {
  const payload: OfflineCustomerSlipPayload = {
    templateVersion: 'manual-receipt-v1',
    storeName: env.BUSINESS_NAME,
    receiptId: receipt.receiptNumber,
    customerName: receipt.customerName?.trim() || 'Walk-in customer',
    phoneMasked: maskPhone(receipt.customerPhone),
    createdAt: receipt.createdAt.toISOString(),
    paymentMethod: receipt.paymentMode,
    subtotal: moneyNumber(receipt.subtotal),
    delivery: moneyNumber(receipt.deliveryCharge),
    discount: moneyNumber(receipt.discount),
    total: moneyNumber(receipt.totalAmount),
    items: receipt.items.map((item) => ({
      name: item.variant.product.name,
      sku: item.variant.product.sku,
      size: item.variant.size,
      quantity: item.quantity,
      unitPrice: moneyNumber(item.unitPrice),
      amount: moneyNumber(item.unitPrice) * item.quantity,
    })),
    barcodeValue: receipt.receiptNumber,
  };
  return parseOfflineCustomerSlipPayload(payload);
}

export function buildManualReceiptReturnSlipPayload(returnRecord: ManualReceiptReturnForSlip): ManualReceiptReturnSlipPayload {
  const payload: ManualReceiptReturnSlipPayload = {
    templateVersion: 'manual-return-slip-v1',
    storeName: env.BUSINESS_NAME,
    receiptId: returnRecord.receipt.receiptNumber,
    returnId: returnRecord.id,
    customerName: returnRecord.receipt.customerName?.trim() || 'Walk-in customer',
    phoneMasked: maskPhone(returnRecord.receipt.customerPhone),
    createdAt: returnRecord.createdAt.toISOString(),
    refundMethod: returnRecord.refundMethod,
    refundAmount: moneyNumber(returnRecord.refundAmount),
    reason: returnRecord.reason,
    items: returnRecord.items.map((item) => ({
      name: item.receiptItem.variant.product.name,
      sku: item.receiptItem.variant.product.sku,
      size: item.receiptItem.variant.size,
      quantity: item.quantity,
      refundAmount: moneyNumber(item.refundAmount),
    })),
    barcodeValue: returnRecord.id,
  };
  return parseManualReceiptReturnSlipPayload(payload);
}

function splitShippingAddress(value: string): { addressLine1: string; addressLine2: string } {
  const parts = value
    .split(/\n|,/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return { addressLine1: '', addressLine2: '' };
  return {
    addressLine1: parts[0] ?? '',
    addressLine2: parts.slice(1).join(', '),
  };
}

function moneyNumber(value: { toString(): string }): number {
  const numberValue = Number(value.toString());
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function nextManualReceiptReprintNumber(receiptId: string): Promise<number> {
  const count = await prisma.printJob.count({
    where: {
      idempotencyKey: { startsWith: `MANUAL_RECEIPT:${receiptId}:REPRINT:` },
      type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
    },
  });
  return count + 2;
}

async function nextManualReturnSlipReprintNumber(returnId: string): Promise<number> {
  const count = await prisma.printJob.count({
    where: {
      idempotencyKey: { startsWith: `MANUAL_RECEIPT_RETURN:${returnId}:REPRINT:` },
      type: PrintJobType.OFFLINE_RETURN_SLIP,
    },
  });
  return count + 2;
}

function withPrintMetadata<T extends object>(payload: T, metadata: Record<string, unknown>): T & { printMetadata: Record<string, unknown> } {
  return {
    ...payload,
    printMetadata: metadata,
  };
}

function existingReprintNumber(job: Pick<PrintJob, 'payload'>, fallback: number): number {
  if (!job.payload || typeof job.payload !== 'object' || Array.isArray(job.payload)) return fallback;
  const metadata = (job.payload as Record<string, unknown>).printMetadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return fallback;
  const value = (metadata as Record<string, unknown>).reprintNumber;
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isUniqueConstraintError(err: unknown): boolean {
  return Boolean(
    err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002',
  );
}
