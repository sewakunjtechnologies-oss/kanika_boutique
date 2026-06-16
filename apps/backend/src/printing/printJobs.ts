import {
  prisma,
  OrderStatus,
  PrintJobStatus,
  PrintJobType,
} from '@kda/db';
import {
  autoOrderLabelIdempotencyKey,
  maskPhone,
  parseLabelPayload,
} from '@kda/labels';
import type { Prisma, PrintJob } from '@kda/db';
import type { LabelPayload } from '@kda/labels';
import { env } from '../config/env';

type Tx = Prisma.TransactionClient;

interface OrderForLabel {
  id: string;
  orderNumber: string;
  shippingName: string;
  shippingAddress: string;
  shippingCity: string;
  shippingState: string;
  shippingPincode: string;
  totalAmount: { toString(): string };
  paymentExtractedUtr: string | null;
  paymentScreenshotUrl: string | null;
  customer: { whatsappNumber: string };
  items: {
    quantity: number;
    variant: {
      size: string;
      product: {
        name: string;
        sku: string;
      };
    };
  }[];
}

export async function createAutomaticOrderLabelJob(tx: Tx, orderId: string): Promise<PrintJob | null> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: {
      customer: { select: { whatsappNumber: true } },
      items: {
        include: {
          variant: { include: { product: { select: { name: true, sku: true } } } },
        },
      },
    },
  });
  if (!order) throw new Error(`order ${orderId} not found`);
  if (order.status !== OrderStatus.VERIFIED && order.status !== OrderStatus.PRINTED) return null;

  const paymentId = paymentIdentifier(order);
  const payload = buildOrderLabelPayload(order);
  return tx.printJob.upsert({
    where: { idempotencyKey: autoOrderLabelIdempotencyKey(order.id, paymentId) },
    create: {
      orderId: order.id,
      type: PrintJobType.ORDER_LABEL,
      status: PrintJobStatus.PENDING,
      payload: payload as never,
      idempotencyKey: autoOrderLabelIdempotencyKey(order.id, paymentId),
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
          variant: { include: { product: { select: { name: true, sku: true } } } },
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
      idempotencyKey: `MANUAL_ORDER_LABEL:${order.id}:${requestedBy}:${Date.now()}`,
    },
  });
}

export async function createTestLabelJob(requestedBy = 'print-agent'): Promise<PrintJob> {
  const payload: LabelPayload = {
    storeName: env.BUSINESS_NAME,
    orderId: 'KD-TEST-1001',
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
    paymentType: 'UPI',
    paymentStatus: 'PAID',
    amount: 2270,
    barcodeValue: 'KD-TEST-1001',
    addressLine: 'H.No. 25, Sector 14',
    labelProfile: '4x3',
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
  return job;
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

export function parsePrintJobPayload(job: Pick<PrintJob, 'payload'>): LabelPayload {
  return parseLabelPayload(job.payload);
}

export function buildOrderLabelPayload(order: OrderForLabel): LabelPayload {
  const firstItem = order.items[0];
  const quantity = order.items.reduce((sum, item) => sum + item.quantity, 0);
  const productSuffix = order.items.length > 1 ? ` +${order.items.length - 1} more` : '';
  const productName = firstItem ? `${firstItem.variant.product.name}${productSuffix}` : 'Order item';
  const address = splitShippingAddress(order.shippingAddress);
  const phoneMasked = maskPhone(order.customer.whatsappNumber);

  return {
    storeName: env.BUSINESS_NAME,
    orderId: order.orderNumber,
    customerName: order.shippingName,
    maskedPhone: phoneMasked,
    phoneMasked,
    pincode: order.shippingPincode,
    productName,
    sku: firstItem?.variant.product.sku ?? '-',
    size: firstItem?.variant.size ?? '-',
    quantity,
    paymentType: 'UPI',
    paymentStatus: 'PAID',
    amount: Number(order.totalAmount.toString()),
    barcodeValue: order.orderNumber,
    addressLine: address.addressLine1,
    addressLine1: address.addressLine1,
    addressLine2: address.addressLine2,
    city: order.shippingCity,
    state: order.shippingState,
    labelProfile: '4x3',
  };
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

function paymentIdentifier(order: Pick<OrderForLabel, 'id' | 'paymentExtractedUtr' | 'paymentScreenshotUrl'>): string {
  return order.paymentExtractedUtr || order.paymentScreenshotUrl || order.id;
}
