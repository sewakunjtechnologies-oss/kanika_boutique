import { describe, expect, test, vi } from 'vitest';

// buildOrderLabelPayload is a pure function over the loaded order; it only needs
// @kda/db for the (unused at runtime here) prisma import and the labels package.
vi.mock('@kda/db', () => ({
  prisma: {},
  OrderStatus: { VERIFIED: 'VERIFIED', PRINTED: 'PRINTED' },
  PrintJobStatus: {},
  PrintJobType: {},
}));

import { buildOrderLabelPayload } from './printJobs';

function order(category: string, backingSize: string) {
  return {
    id: 'o1',
    orderNumber: 'ORD-2026-0001',
    createdAt: new Date('2026-06-29T00:00:00Z'),
    shippingName: 'Asha',
    shippingAddress: 'H.No 5, Sector 2, Sonipat, Haryana',
    shippingCity: 'Sonipat',
    shippingState: 'Haryana',
    shippingPincode: '131001',
    subtotal: '2765',
    shippingFee: '100',
    totalAmount: '2865',
    paymentExtractedUtr: null,
    paymentScreenshotUrl: null,
    customer: { whatsappNumber: '919999999999' },
    items: [
      {
        quantity: 1,
        unitPrice: '2765',
        variant: { size: backingSize, product: { name: 'Pure Muslin Suit', sku: 'UN-201', category } },
      },
    ],
  };
}

describe('buildOrderLabelPayload — size mode on the printed receipt', () => {
  test('unstitched order prints "Free Size" even when the backing variant is numeric', () => {
    const payload = buildOrderLabelPayload(order('Unstitched Suits', '40') as never);
    expect(payload.size).toBe('Free Size');
    expect(payload.items[0]?.size).toBe('Free Size');
    // The label (owner-side) must keep full product identity even though the
    // customer-facing WhatsApp copy hides it.
    expect(payload.productName).toBe('Pure Muslin Suit');
    expect(payload.sku).toBe('UN-201');
    expect(payload.items[0]?.name).toBe('Pure Muslin Suit');
    expect(payload.items[0]?.sku).toBe('UN-201');
  });

  test('unstitched order with a "Free Size" backing variant still prints "Free Size"', () => {
    const payload = buildOrderLabelPayload(order('Unstitched Suits', 'Free Size') as never);
    expect(payload.size).toBe('Free Size');
  });

  test('stitched order prints the numeric size', () => {
    const payload = buildOrderLabelPayload(order('Stitched Suits', '40') as never);
    expect(payload.size).toBe('40');
    expect(payload.items[0]?.size).toBe('40');
  });

  test('never prints null/undefined/N/A', () => {
    const payload = buildOrderLabelPayload(order('Unstitched Suits', '') as never);
    expect(payload.size).toBe('Free Size');
    expect(['null', 'undefined', 'N/A']).not.toContain(payload.size);
  });
});
