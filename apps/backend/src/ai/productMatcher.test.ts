import { describe, expect, test } from 'vitest';
import {
  classifyProductMatchConfidence,
  MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD,
  PRODUCT_MATCH_CONFIDENCE_THRESHOLD,
} from './productMatcher';

describe('productMatcher confidence bands', () => {
  test('classifies high confidence at the order-confirmation threshold', () => {
    expect(classifyProductMatchConfidence(PRODUCT_MATCH_CONFIDENCE_THRESHOLD)).toBe('high');
  });

  test('classifies medium confidence below high threshold', () => {
    expect(classifyProductMatchConfidence(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD)).toBe('medium');
  });

  test('classifies low confidence below medium threshold', () => {
    expect(classifyProductMatchConfidence(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD - 0.01)).toBe('low');
  });
});
