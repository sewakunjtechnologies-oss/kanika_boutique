import { describe, expect, test } from 'vitest';
import { OrderStatus } from '@kda/db';
import { calculateDeliveryCharge } from '@kda/shared';
import { isReservationActiveForStock } from './orderService';

describe('delivery charge calculation', () => {
  test('charges 100 for one piece', () => {
    expect(calculateDeliveryCharge(1)).toBe(100);
  });

  test('charges 150 for two pieces', () => {
    expect(calculateDeliveryCharge(2)).toBe(150);
  });

  test('charges 200 for three pieces', () => {
    expect(calculateDeliveryCharge(3)).toBe(200);
  });

  test('charges 250 for four pieces', () => {
    expect(calculateDeliveryCharge(4)).toBe(250);
  });
});

describe('reservation expiry', () => {
  const now = new Date('2026-06-06T00:00:00.000Z');

  test('pending order reserves stock until expiry', () => {
    expect(
      isReservationActiveForStock(
        OrderStatus.PENDING,
        new Date('2026-06-06T00:05:00.000Z'),
        now,
      ),
    ).toBe(true);
  });

  test('expired pending order no longer reserves stock', () => {
    expect(
      isReservationActiveForStock(
        OrderStatus.PENDING,
        new Date('2026-06-05T23:59:59.000Z'),
        now,
      ),
    ).toBe(false);
  });

  test('payment review continues to reserve stock', () => {
    expect(isReservationActiveForStock(OrderStatus.PAYMENT_REVIEW, null, now)).toBe(true);
  });
});
