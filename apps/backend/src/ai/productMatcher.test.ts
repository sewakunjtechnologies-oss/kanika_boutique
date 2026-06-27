import { describe, expect, test } from 'vitest';
import {
  classifyProductMatchConfidence,
  hasClearBestImageCandidate,
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

  test('accepts a clear best match only when it beats the runner-up margin', () => {
    expect(hasClearBestImageCandidate(0.96, 0.89, 0.04)).toBe(true);
    expect(hasClearBestImageCandidate(0.96, 0.94, 0.04)).toBe(false);
    expect(hasClearBestImageCandidate(0.96, undefined, 0.04)).toBe(true);
  });
});
