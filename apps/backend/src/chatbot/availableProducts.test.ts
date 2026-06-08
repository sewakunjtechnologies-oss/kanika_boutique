import { ConversationState } from '@kda/db';
import { describe, expect, test } from 'vitest';
import {
  buildAvailableProductOptions,
  formatAvailableProductList,
  isRejectedProductFlow,
  type AvailableProductOption,
} from './orchestrator';

const rows = [
  {
    id: 'rejected',
    sku: 'A1',
    name: 'Article 1 Blue Floral Suit',
    basePrice: { toString: () => '2270' },
    variants: [
      { size: '38', stock: 3 },
      { size: '40', stock: 2 },
    ],
  },
  {
    id: 'p2',
    sku: 'A2',
    name: 'Article 2 Pink Cotton Suit',
    basePrice: { toString: () => '2490' },
    variants: [
      { size: '38', stock: 1 },
      { size: '42', stock: 0 },
    ],
  },
  {
    id: 'p3',
    sku: 'A3',
    name: 'Article 3 Green Kurti',
    basePrice: { toString: () => '1890' },
    variants: [
      { size: '40', stock: 2 },
    ],
  },
];

describe('available product options', () => {
  test('after product rejection, available list excludes rejected product', () => {
    const products = buildAvailableProductOptions(rows, {
      size: null,
      excludedProductId: 'rejected',
      limit: 3,
    });

    expect(products.map((product) => product.id)).toEqual(['p2', 'p3']);
  });

  test('size-specific query returns only products with requested size in stock', () => {
    const products = buildAvailableProductOptions(rows, {
      size: '38',
      excludedProductId: 'rejected',
      limit: 3,
    });

    expect(products.map((product) => product.id)).toEqual(['p2']);
    expect(products[0]?.sizes).toEqual(['38']);
  });

  test('no products in requested size returns empty list for fallback reply', () => {
    const products = buildAvailableProductOptions(rows, {
      size: '46',
      excludedProductId: 'rejected',
      limit: 3,
    });

    expect(products).toEqual([]);
  });

  test('rejected-product flow blocks quoting stock/price for the rejected product', () => {
    // Even if a stale productId lingers, the FAQ path must treat the customer as
    // being in the rejected flow and never quote that product's stock.
    expect(
      isRejectedProductFlow(ConversationState.AWAITING_NEW_PRODUCT, { productId: 'rejected' }),
    ).toBe(true);
    expect(
      isRejectedProductFlow(ConversationState.AWAITING_PRODUCT_CONFIRMATION, {
        productRejected: true,
        productId: 'rejected',
      }),
    ).toBe(true);
    expect(
      isRejectedProductFlow(ConversationState.AWAITING_PRODUCT_CONFIRMATION, {
        lastMatchedProductRejected: true,
      }),
    ).toBe(true);
  });

  test('a freshly selected product (not rejected) is not treated as rejected flow', () => {
    // After picking product "1" from the list we set productRejected=false, so the
    // bot may quote that product's stock/price normally.
    expect(
      isRejectedProductFlow(ConversationState.AWAITING_PRODUCT_CONFIRMATION, {
        productId: 'p2',
        productRejected: false,
        lastMatchedProductRejected: false,
      }),
    ).toBe(false);
    expect(isRejectedProductFlow(ConversationState.AWAITING_SIZE, { productId: 'p2' })).toBe(false);
  });

  test('formats numbered list and asks customer to pick by number', () => {
    const products: AvailableProductOption[] = [
      { id: 'p2', sku: 'A2', name: 'Article 2 Pink Cotton Suit', basePrice: '2490', sizes: ['38'] },
      { id: 'p3', sku: 'A3', name: 'Article 3 Green Kurti', basePrice: '1890', sizes: ['40'] },
    ];

    expect(formatAvailableProductList(products)).toBe(
      '1. Article 2 Pink Cotton Suit — ₹2490 — sizes 38\n2. Article 3 Green Kurti — ₹1890 — sizes 40',
    );
  });
});
