import { beforeEach, describe, expect, test } from 'vitest';
import { env } from '../config/env';
import {
  classifyImageMatchDecision,
  classifyProductMatchConfidence,
  hasClearBestImageCandidate,
  MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD,
  PRODUCT_MATCH_CONFIDENCE_THRESHOLD,
} from './productMatcher';

describe('productMatcher confidence bands', () => {
  beforeEach(() => {
    env.IMAGE_MATCH_THRESHOLD = 0.5;
    env.IMAGE_AUTO_MATCH_THRESHOLD = 0.5;
    env.IMAGE_CANDIDATE_MATCH_THRESHOLD = 0.5;
    env.IMAGE_MIN_SCORE_MARGIN = 0.04;
    env.IMAGE_NEAR_DUPLICATE_THRESHOLD = 0.88;
    env.IMAGE_NEAR_DUPLICATE_PHASH_THRESHOLD = 0.78;
    env.IMAGE_NEAR_DUPLICATE_PIXEL_THRESHOLD = 0.82;
    env.IMAGE_NEAR_DUPLICATE_EDGE_THRESHOLD = 0.82;
    env.IMAGE_NEAR_DUPLICATE_FEATURE_THRESHOLD = 0.88;
  });

  test('classifies high confidence at the order-confirmation threshold', () => {
    expect(classifyProductMatchConfidence(PRODUCT_MATCH_CONFIDENCE_THRESHOLD)).toBe('high');
    expect(PRODUCT_MATCH_CONFIDENCE_THRESHOLD).toBe(0.5);
  });

  test('legacy medium threshold is normalized to the production match threshold', () => {
    expect(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD).toBe(0.5);
  });

  test('classifies low confidence below the production threshold', () => {
    expect(classifyProductMatchConfidence(0.49)).toBe('low');
  });

  test('accepts a clear best match only when it beats the runner-up margin', () => {
    expect(hasClearBestImageCandidate(0.96, 0.91, 0.04)).toBe(true);
    expect(hasClearBestImageCandidate(0.96, 0.93, 0.04)).toBe(false);
    expect(hasClearBestImageCandidate(0.96, undefined, 0.04)).toBe(true);
  });

  test('only clear above-threshold matches are accepted', () => {
    expect(classifyImageMatchDecision(0.7, 0.09)).toBe('auto_match');
    expect(classifyImageMatchDecision(0.7, 0.03)).toBe('no_match');
    expect(classifyImageMatchDecision(0.52, 0.4)).toBe('auto_match');
    expect(classifyImageMatchDecision(0.49, 1)).toBe('no_match');
  });

  test('threshold boundary is inclusive at exactly 0.50 and exclusive below it', () => {
    expect(classifyImageMatchDecision(0.5, 0.04)).toBe('auto_match');
    expect(classifyImageMatchDecision(0.499, 1)).toBe('no_match');
    expect(classifyImageMatchDecision(0.501, 0.039)).toBe('no_match');
    expect(classifyImageMatchDecision(0.501, 0.04)).toBe('auto_match');
  });

  test('exact and near-duplicate matches bypass the generic runner-up margin', () => {
    expect(classifyImageMatchDecision(1, 0, 'EXACT_MATCH')).toBe('auto_match');
    expect(classifyImageMatchDecision(0.91, 0.001, 'NEAR_DUPLICATE_MATCH')).toBe('auto_match');
  });

  test('general visual matches retain ambiguity protection', () => {
    expect(classifyImageMatchDecision(0.91, 0.001, 'GENERAL_MATCH')).toBe('no_match');
    expect(classifyImageMatchDecision(0.91, 0.04, 'GENERAL_MATCH')).toBe('auto_match');
  });
});
