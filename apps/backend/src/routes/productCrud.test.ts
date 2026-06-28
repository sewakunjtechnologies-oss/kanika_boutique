import { describe, expect, test } from 'vitest';
import { productListStatusWhere, decideProductDeletion } from './productCrud';

describe('product list status filter', () => {
  test('default (active) excludes archived products', () => {
    expect(productListStatusWhere(undefined)).toEqual({ isActive: true });
    expect(productListStatusWhere('active')).toEqual({ isActive: true });
    expect(productListStatusWhere('anything-else')).toEqual({ isActive: true });
  });

  test('archived returns only archived', () => {
    expect(productListStatusWhere('archived')).toEqual({ isActive: false });
  });

  test('all returns everything (no isActive filter)', () => {
    expect(productListStatusWhere('all')).toEqual({});
  });
});

describe('product deletion strategy', () => {
  test('5: hard delete of an UNREFERENCED product → deleted', () => {
    expect(decideProductDeletion({ hard: true, isReferenced: false })).toBe('deleted');
  });

  test('6 + 12: hard delete of a REFERENCED product → archived (never a 500/orphan)', () => {
    expect(decideProductDeletion({ hard: true, isReferenced: true })).toBe('archived');
  });

  test('non-hard request always archives (soft delete)', () => {
    expect(decideProductDeletion({ hard: false, isReferenced: false })).toBe('archived');
    expect(decideProductDeletion({ hard: false, isReferenced: true })).toBe('archived');
  });
});
