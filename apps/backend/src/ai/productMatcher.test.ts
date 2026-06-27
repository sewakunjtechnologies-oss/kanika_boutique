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
    env.IMAGE_AUTO_MATCH_THRESHOLD = 0.65;
    env.IMAGE_CANDIDATE_MATCH_THRESHOLD = 0.45;
    env.IMAGE_MIN_SCORE_MARGIN = 0.08;
  });

  test('classifies high confidence at the order-confirmation threshold', () => {
    expect(classifyProductMatchConfidence(PRODUCT_MATCH_CONFIDENCE_THRESHOLD)).toBe('high');
    expect(PRODUCT_MATCH_CONFIDENCE_THRESHOLD).toBe(0.65);
  });

  test('classifies medium confidence below high threshold', () => {
    expect(classifyProductMatchConfidence(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD)).toBe('medium');
    expect(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD).toBe(0.45);
  });

  test('classifies low confidence below medium threshold', () => {
    expect(classifyProductMatchConfidence(MEDIUM_PRODUCT_MATCH_CONFIDENCE_THRESHOLD - 0.01)).toBe('low');
  });

  test('accepts a clear best match only when it beats the runner-up margin', () => {
    expect(hasClearBestImageCandidate(0.96, 0.87, 0.08)).toBe(true);
    expect(hasClearBestImageCandidate(0.96, 0.9, 0.08)).toBe(false);
    expect(hasClearBestImageCandidate(0.96, undefined, 0.08)).toBe(true);
  });

  test('classifies image match decisions without silently rejecting likely matches', () => {
    expect(classifyImageMatchDecision(0.7, 0.09)).toBe('auto_match');
    expect(classifyImageMatchDecision(0.7, 0.03)).toBe('candidate_confirmation');
    expect(classifyImageMatchDecision(0.52, 0.4)).toBe('candidate_confirmation');
    expect(classifyImageMatchDecision(0.44, 1)).toBe('no_match');
  });
});
