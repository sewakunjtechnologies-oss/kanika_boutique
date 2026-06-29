import { describe, expect, test } from 'vitest';
import {
  FREE_SIZE_CANONICAL,
  FREE_SIZE_DISPLAY,
  displaySizeFor,
  isUnstitchedCategory,
  pickFreeSizeVariant,
  resolveProductSizeMode,
} from './sizeMode';

describe('resolveProductSizeMode — unstitched source of truth', () => {
  const unstitchedNames = [
    'unstitched',
    'Unstitched',
    'Unstitched Suit',
    'Unstitched Suits',
    'unstitched-suit',
    'unstitched-suits',
    'Free Size',
    'free-size',
    'UNSTITCHED SUITS',
  ];

  test.each(unstitchedNames)('category "%s" resolves to FREE_SIZE, no size selection', (category) => {
    const r = resolveProductSizeMode({ category });
    expect(r.sizeMode).toBe('FREE_SIZE');
    expect(r.requiresSizeSelection).toBe(false);
    expect(r.selectedDefaultSize).toBe(FREE_SIZE_CANONICAL);
  });

  test('resolves by stable slug even if the display name is generic', () => {
    const r = resolveProductSizeMode({ category: 'Suits', categorySlug: 'unstitched-suits' });
    expect(r.sizeMode).toBe('FREE_SIZE');
    expect(r.requiresSizeSelection).toBe(false);
  });

  const stitchedNames = ['Stitched Suits', 'Suits', 'Lehengas', 'Sarees', 'Kurtis', 'Anarkali Suit'];
  test.each(stitchedNames)('category "%s" resolves to SIZED and requires size selection', (category) => {
    const r = resolveProductSizeMode({ category });
    expect(r.sizeMode).toBe('SIZED');
    expect(r.requiresSizeSelection).toBe(true);
    expect(r.selectedDefaultSize).toBeNull();
  });

  test('explicit sizeMode field overrides category', () => {
    expect(resolveProductSizeMode({ category: 'Stitched Suits', sizeMode: 'FREE_SIZE' }).sizeMode).toBe('FREE_SIZE');
    expect(resolveProductSizeMode({ category: 'Unstitched Suits', sizeMode: 'SIZED' }).sizeMode).toBe('SIZED');
  });

  test('empty / missing category is treated as SIZED (safe default)', () => {
    expect(resolveProductSizeMode({}).sizeMode).toBe('SIZED');
    expect(resolveProductSizeMode({ category: '' }).sizeMode).toBe('SIZED');
  });

  test('"unstitched" substring containing "stitched" is not misclassified', () => {
    expect(isUnstitchedCategory('Unstitched Suits')).toBe(true);
    expect(isUnstitchedCategory('Stitched Suits')).toBe(false);
  });
});

describe('pickFreeSizeVariant — canonical variant for free-size orders', () => {
  test('returns null when nothing is in stock', () => {
    expect(pickFreeSizeVariant([{ id: 'a', size: '40', stock: 0 }])).toBeNull();
  });

  test('prefers a free-size-labelled variant over numeric rows', () => {
    const picked = pickFreeSizeVariant([
      { id: 'n1', size: '40', stock: 5 },
      { id: 'fs', size: 'Free Size', stock: 1 },
    ]);
    expect(picked?.id).toBe('fs');
  });

  test('ignores legacy numeric sizes and picks the highest-stock in-stock variant', () => {
    // Three legacy numeric size rows, no free-size row → still selects one variant.
    const picked = pickFreeSizeVariant([
      { id: 'a', size: '38', stock: 2 },
      { id: 'b', size: '40', stock: 9 },
      { id: 'c', size: '42', stock: 4 },
    ]);
    expect(picked?.id).toBe('b');
  });

  test('deterministic on ties (stable by id)', () => {
    const picked = pickFreeSizeVariant([
      { id: 'z', size: '40', stock: 3 },
      { id: 'a', size: '42', stock: 3 },
    ]);
    expect(picked?.id).toBe('a');
  });
});

describe('displaySizeFor — receipt/display rendering', () => {
  test('FREE_SIZE always renders "Free Size" regardless of backing size', () => {
    expect(displaySizeFor('FREE_SIZE', '40')).toBe(FREE_SIZE_DISPLAY);
    expect(displaySizeFor('FREE_SIZE', undefined)).toBe(FREE_SIZE_DISPLAY);
    expect(displaySizeFor('FREE_SIZE', '')).toBe(FREE_SIZE_DISPLAY);
  });

  test('SIZED renders the real size, never null/undefined/N/A', () => {
    expect(displaySizeFor('SIZED', '40')).toBe('40');
    expect(displaySizeFor('SIZED', undefined)).toBe('-');
    expect(displaySizeFor('SIZED', '')).toBe('-');
  });
});
