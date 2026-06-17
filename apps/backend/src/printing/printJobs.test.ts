import { afterEach, describe, expect, test, vi } from 'vitest';
import { OrderStatus, PrintJobStatus, PrintJobType, prisma } from '@kda/db';
import {
  buildManualReceiptSlipPayload,
  buildOrderLabelPayload,
  cancelPendingTestLabelJobs,
  claimNextPrintJob,
  createAutomaticOrderLabelJob,
  createManualReceiptSlipJob,
  markPrintJobDryRunCompleted,
} from './printJobs';

const order = {
  id: 'order_123',
  orderNumber: 'KDA-123',
  status: OrderStatus.VERIFIED,
  shippingName: 'Test Customer',
  shippingAddress: 'A very long address, Near Market',
  shippingCity: 'Sonipat',
  shippingState: 'Haryana',
  shippingPincode: '110001',
  totalAmount: { toString: () => '4540' },
  paymentExtractedUtr: 'UTR123',
  paymentScreenshotUrl: 'uploads/payment.png',
  customerId: 'customer_1',
  customer: { whatsappNumber: '919876543210' },
  items: [
    {
      quantity: 2,
      variant: {
        size: '40',
        product: { name: 'Blue Floral Pure Cotton Suit', sku: 'ARTICLE-1' },
      },
    },
  ],
};

const receipt = {
  id: 'receipt_123',
  receiptNumber: 'MR-2026-0001',
  customerName: 'test-1',
  customerPhone: '917400000041',
  subtotal: { toString: () => '1760.00' },
  deliveryCharge: { toString: () => '100.00' },
  discount: { toString: () => '0.00' },
  totalAmount: { toString: () => '1860.00' },
  paymentMode: 'CASH',
  createdAt: new Date('2026-06-17T10:09:00.000Z'),
  items: [
    {
      quantity: 1,
      unitPrice: { toString: () => '1760.00' },
      variant: {
        size: '38',
        product: { name: 'Three-piece Kurti', sku: 'three-piece-kurtis-mq6b1e77' },
      },
    },
  ],
};

describe('print jobs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('builds a compact masked order label payload', () => {
    const payload = buildOrderLabelPayload(order);

    expect(payload.templateVersion).toBe('online-order-label-v1');
    expect(payload.orderId).toBe('KDA-123');
    expect(payload.maskedPhone).toBe('98XXXXXXXX10');
    expect(payload.phoneMasked).toBe('98XXXXXXXX10');
    expect(payload.addressLine1).toBe('A very long address');
    expect(payload.addressLine2).toBe('Near Market');
    expect(payload.city).toBe('Sonipat');
    expect(payload.state).toBe('Haryana');
    expect(payload.pincode).toBe('110001');
    expect(payload.labelProfile).toBe('4x3_standard');
    expect(payload.productName).toBe('Blue Floral Pure Cotton Suit');
    expect(payload.sku).toBe('ARTICLE-1');
    expect(payload.size).toBe('40');
    expect(payload.quantity).toBe(2);
    expect(payload.paymentType).toBe('UPI');
    expect(payload.amount).toBe(4540);
  });

  test('payment approval creates an idempotent automatic order label job', async () => {
    const upsert = vi.fn().mockResolvedValue({ id: 'job_1' });
    const tx = {
      order: { findUnique: vi.fn().mockResolvedValue(order) },
      printJob: { upsert },
    };

    await createAutomaticOrderLabelJob(tx as never, order.id);
    await createAutomaticOrderLabelJob(tx as never, order.id);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[0]?.[0].where.idempotencyKey).toBe('AUTO_ORDER_LABEL:order_123:UTR123');
    expect(upsert.mock.calls[1]?.[0].where.idempotencyKey).toBe('AUTO_ORDER_LABEL:order_123:UTR123');
    expect(upsert.mock.calls[0]?.[0].create.type).toBe(PrintJobType.ORDER_LABEL);
    expect(upsert.mock.calls[0]?.[0].create.status).toBe(PrintJobStatus.PENDING);
  });

  test('does not create an automatic label for unverified orders', async () => {
    const upsert = vi.fn();
    const tx = {
      order: { findUnique: vi.fn().mockResolvedValue({ ...order, status: OrderStatus.PAYMENT_RECEIVED }) },
      printJob: { upsert },
    };

    const result = await createAutomaticOrderLabelJob(tx as never, order.id);

    expect(result).toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  test('builds a manual receipt slip payload with serializable money values', () => {
    const payload = buildManualReceiptSlipPayload(receipt);

    expect(payload.templateVersion).toBe('manual-receipt-v1');
    expect(payload.receiptId).toBe('MR-2026-0001');
    expect(payload.customerName).toBe('test-1');
    expect(payload.phoneMasked).toBe('74XXXXXXXX41');
    expect(payload.subtotal).toBe(1760);
    expect(payload.delivery).toBe(100);
    expect(payload.discount).toBe(0);
    expect(payload.total).toBe(1860);
    expect(payload.items[0]).toMatchObject({
      name: 'Three-piece Kurti',
      sku: 'three-piece-kurtis-mq6b1e77',
      size: '38',
      quantity: 1,
      unitPrice: 1760,
      amount: 1760,
    });
    expect('addressLine1' in payload).toBe(false);
    expect('city' in payload).toBe(false);
    expect('pincode' in payload).toBe(false);
    expect(payload.labelProfile).toBe('4x3_standard');
  });

  test('existing manual receipt creates an OFFLINE_CUSTOMER_SLIP job', async () => {
    vi.spyOn(prisma.manualReceipt, 'findUnique').mockResolvedValue(receipt as never);
    vi.spyOn(prisma.printJob, 'findUnique').mockResolvedValue(null);
    const create = vi.spyOn(prisma.printJob, 'create').mockResolvedValue({
      id: 'job_receipt',
      type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
      status: PrintJobStatus.PENDING,
    } as never);

    const result = await createManualReceiptSlipJob({ receiptId: receipt.id, requestedBy: 'admin_1' });

    expect(result?.created).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0].data.type).toBe(PrintJobType.OFFLINE_CUSTOMER_SLIP);
    expect(create.mock.calls[0]?.[0].data.idempotencyKey).toBe('MANUAL_RECEIPT:receipt_123:INITIAL');
  });

  test('missing manual receipt returns null', async () => {
    vi.spyOn(prisma.manualReceipt, 'findUnique').mockResolvedValue(null);

    const result = await createManualReceiptSlipJob({ receiptId: 'missing', requestedBy: 'admin_1' });

    expect(result).toBeNull();
  });

  test('double-click initial print does not create a duplicate job', async () => {
    const existingJob = { id: 'existing_job', status: PrintJobStatus.PENDING };
    vi.spyOn(prisma.manualReceipt, 'findUnique').mockResolvedValue(receipt as never);
    vi.spyOn(prisma.printJob, 'findUnique').mockResolvedValue(existingJob as never);
    const create = vi.spyOn(prisma.printJob, 'create');

    const result = await createManualReceiptSlipJob({ receiptId: receipt.id, requestedBy: 'admin_1' });

    expect(result?.created).toBe(false);
    expect(result?.job).toBe(existingJob);
    expect(create).not.toHaveBeenCalled();
  });

  test('manual receipt reprint creates a fresh job', async () => {
    vi.spyOn(prisma.manualReceipt, 'findUnique').mockResolvedValue(receipt as never);
    const create = vi.spyOn(prisma.printJob, 'create').mockResolvedValue({
      id: 'reprint_job',
      type: PrintJobType.OFFLINE_CUSTOMER_SLIP,
      status: PrintJobStatus.PENDING,
    } as never);

    await createManualReceiptSlipJob({ receiptId: receipt.id, requestedBy: 'admin_1', reprint: true });

    expect(create).toHaveBeenCalledTimes(1);
    expect(String(create.mock.calls[0]?.[0].data.idempotencyKey)).toContain('MANUAL_RECEIPT:receipt_123:REPRINT:');
  });

  test('dry-run completion does not mark the job physically printed', async () => {
    const updateMany = vi.spyOn(prisma.printJob, 'updateMany').mockResolvedValue({ count: 1 } as never);
    const findUnique = vi.spyOn(prisma.printJob, 'findUnique').mockResolvedValue({
      id: 'dry_job',
      status: PrintJobStatus.DRY_RUN_COMPLETED,
    } as never);

    const result = await markPrintJobDryRunCompleted('dry_job', 'bridge_1');

    expect(result?.status).toBe(PrintJobStatus.DRY_RUN_COMPLETED);
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({ status: PrintJobStatus.DRY_RUN_COMPLETED });
    expect(JSON.stringify(updateMany.mock.calls[0]?.[0].data)).not.toContain(PrintJobStatus.PRINTED);
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'dry_job' } });
  });

  test('can cancel all pending TEST_LABEL jobs', async () => {
    const updateMany = vi.spyOn(prisma.printJob, 'updateMany').mockResolvedValue({ count: 3 } as never);

    const cancelled = await cancelPendingTestLabelJobs('admin_1');

    expect(cancelled).toBe(3);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        type: PrintJobType.TEST_LABEL,
        status: PrintJobStatus.PENDING,
      },
      data: expect.objectContaining({
        status: PrintJobStatus.CANCELLED,
      }),
    });
  });

  test('claimNextPrintJob claims only one oldest pending job', async () => {
    const job = { id: 'job_one', status: PrintJobStatus.PENDING };
    const tx = {
      printJob: {
        updateMany: vi.fn()
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(job),
        findUnique: vi.fn().mockResolvedValue({ ...job, status: PrintJobStatus.CLAIMED }),
      },
    };
    const transactionSpy = vi.spyOn(prisma, '$transaction') as unknown as {
      mockImplementation: (impl: (callback: unknown) => Promise<unknown>) => void;
    };
    transactionSpy.mockImplementation(async (callback: unknown) => {
      if (typeof callback !== 'function') return [];
      return (callback as (client: typeof tx) => Promise<unknown>)(tx);
    });

    const result = await claimNextPrintJob('bridge_1');

    expect(result?.id).toBe('job_one');
    expect(tx.printJob.findFirst).toHaveBeenCalledTimes(1);
    expect(tx.printJob.findFirst.mock.calls[0]?.[0].orderBy).toEqual([{ createdAt: 'asc' }]);
    expect(tx.printJob.updateMany.mock.calls[1]?.[0].where).toMatchObject({
      id: 'job_one',
      status: PrintJobStatus.PENDING,
    });
  });
});
