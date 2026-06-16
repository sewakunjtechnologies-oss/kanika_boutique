import { describe, expect, test, vi } from 'vitest';
import { OrderStatus, PrintJobStatus, PrintJobType } from '@kda/db';
import { buildOrderLabelPayload, createAutomaticOrderLabelJob } from './printJobs';

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

describe('print jobs', () => {
  test('builds a compact masked order label payload', () => {
    const payload = buildOrderLabelPayload(order);

    expect(payload.orderId).toBe('KDA-123');
    expect(payload.maskedPhone).toBe('98XXXXXXXX10');
    expect(payload.phoneMasked).toBe('98XXXXXXXX10');
    expect(payload.addressLine1).toBe('A very long address');
    expect(payload.addressLine2).toBe('Near Market');
    expect(payload.city).toBe('Sonipat');
    expect(payload.state).toBe('Haryana');
    expect(payload.labelProfile).toBe('4x3');
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
});
