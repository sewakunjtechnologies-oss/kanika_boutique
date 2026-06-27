import { describe, expect, test } from 'vitest';
import {
  filterReceiptProducts,
  findDefaultVariant,
  isSelectableReceiptProduct,
  productAvailableSizes,
  productDisplayName,
  productTotalStock,
  type ManualReceiptProduct,
} from './manual-receipt-products';

const unnamedProduct: ManualReceiptProduct = {
  id: 'p1',
  name: null,
  sku: 'ART-1001',
  category: 'Three-piece Kurtis',
  imageUrl: '/uploads/products/art-1001.jpg',
  basePrice: '1760',
  isActive: true,
  variants: [
    { id: 'v1', size: '38', stock: 0, priceOverride: null },
    { id: 'v2', size: '40', stock: 3, priceOverride: '1800' },
  ],
};

describe('manual receipt product selector helpers', () => {
  test('keeps unnamed products selectable by image and SKU', () => {
    expect(productDisplayName(unnamedProduct)).toBe('Unnamed product');
    expect(isSelectableReceiptProduct(unnamedProduct)).toBe(true);
    expect(findDefaultVariant(unnamedProduct)?.id).toBe('v2');
  });

  test('shows available sizes and total stock', () => {
    expect(productAvailableSizes(unnamedProduct)).toEqual(['40']);
    expect(productTotalStock(unnamedProduct)).toBe(3);
  });

  test('searches by SKU and category while excluding inactive products', () => {
    const inactive: ManualReceiptProduct = {
      ...unnamedProduct,
      id: 'p2',
      sku: 'HIDDEN',
      isActive: false,
    };

    expect(filterReceiptProducts([unnamedProduct, inactive], 'art-1001')).toEqual([unnamedProduct]);
    expect(filterReceiptProducts([unnamedProduct, inactive], 'three-piece')).toEqual([unnamedProduct]);
  });

  test('out-of-stock products cannot be selected', () => {
    const outOfStock: ManualReceiptProduct = {
      ...unnamedProduct,
      variants: [{ id: 'v1', size: '38', stock: 0, priceOverride: null }],
    };

    expect(isSelectableReceiptProduct(outOfStock)).toBe(false);
  });
});
