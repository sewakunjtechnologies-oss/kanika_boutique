import { describe, expect, test } from 'vitest';
import { ManualReceiptStatus, Prisma, ReceiptReturnStatus, RefundMethod } from '@kda/db';
import {
  calculateManualReceiptReturn,
  ManualReceiptReturnError,
  previouslyReturnedQuantityByItem,
} from './returns';

const item1 = {
  id: 'item_1',
  productVariantId: 'variant_1',
  quantity: 2,
  unitPrice: new Prisma.Decimal(1000),
  variant: { product: { name: 'Suit A', sku: 'SKU-A' } },
};

const item2 = {
  id: 'item_2',
  productVariantId: 'variant_2',
  quantity: 1,
  unitPrice: new Prisma.Decimal(500),
  variant: { product: { name: 'Suit B', sku: 'SKU-B' } },
};

function receipt(overrides: Partial<Parameters<typeof calculateManualReceiptReturn>[0]> = {}) {
  return {
    id: 'receipt_1',
    receiptNumber: 'MR-2026-0001',
    status: ManualReceiptStatus.ACTIVE,
    discount: new Prisma.Decimal(100),
    items: [item1, item2],
    returns: [],
    ...overrides,
  };
}

describe('manual receipt returns', () => {
  test('calculates refund on product value with proportional discount and excludes delivery', () => {
    const calculation = calculateManualReceiptReturn(
      receipt(),
      [{ receiptItemId: 'item_1', quantity: 1 }],
      RefundMethod.CASH,
    );

    expect(calculation.refundAmount.toString()).toBe('960');
    expect(calculation.lines[0]?.grossAmount.toString()).toBe('1000');
    expect(calculation.lines[0]?.discountShare.toString()).toBe('40');
    expect(calculation.nextStatus).toBe(ManualReceiptStatus.PARTIALLY_RETURNED);
  });

  test('full return changes status to RETURNED without mutating original sold quantities', () => {
    const original = receipt();
    const calculation = calculateManualReceiptReturn(
      original,
      [
        { receiptItemId: 'item_1', quantity: 2 },
        { receiptItemId: 'item_2', quantity: 1 },
      ],
      RefundMethod.UPI,
    );

    expect(calculation.refundAmount.toString()).toBe('2400');
    expect(calculation.nextStatus).toBe(ManualReceiptStatus.RETURNED);
    expect(original.items[0]?.quantity).toBe(2);
    expect(original.items[1]?.quantity).toBe(1);
  });

  test('previous returned quantities reduce remaining returnable stock', () => {
    const previous = receipt({
      returns: [
        {
          status: ReceiptReturnStatus.COMPLETED,
          items: [{ manualReceiptItemId: 'item_1', quantity: 1 }],
        },
      ],
    });

    expect(previouslyReturnedQuantityByItem(previous).get('item_1')).toBe(1);
    expect(() =>
      calculateManualReceiptReturn(
        previous,
        [{ receiptItemId: 'item_1', quantity: 2 }],
        RefundMethod.CASH,
      ),
    ).toThrow(ManualReceiptReturnError);
  });

  test('NO_REFUND records return with zero refund amount', () => {
    const calculation = calculateManualReceiptReturn(
      receipt(),
      [{ receiptItemId: 'item_2', quantity: 1 }],
      RefundMethod.NO_REFUND,
    );

    expect(calculation.refundAmount.toString()).toBe('0');
    expect(calculation.lines[0]?.refundAmount.toString()).toBe('0');
  });

  test('invalid return quantities and unrelated items are rejected', () => {
    expect(() =>
      calculateManualReceiptReturn(
        receipt(),
        [{ receiptItemId: 'item_1', quantity: 0 }],
        RefundMethod.CASH,
      ),
    ).toThrow(ManualReceiptReturnError);

    expect(() =>
      calculateManualReceiptReturn(
        receipt(),
        [{ receiptItemId: 'other_item', quantity: 1 }],
        RefundMethod.CASH,
      ),
    ).toThrow(ManualReceiptReturnError);
  });

  test('voided receipts cannot be returned', () => {
    expect(() =>
      calculateManualReceiptReturn(
        receipt({ status: ManualReceiptStatus.VOIDED }),
        [{ receiptItemId: 'item_1', quantity: 1 }],
        RefundMethod.CASH,
      ),
    ).toThrow(ManualReceiptReturnError);
  });
});
