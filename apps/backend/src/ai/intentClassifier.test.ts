import { afterEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';
import { callJsonOutput } from './callJsonOutput';
import { classifyCustomerIntent, classifyCustomerIntentDeterministic } from './intentClassifier';

vi.mock('./callJsonOutput', () => ({
  callJsonOutput: vi.fn(),
}));

afterEach(() => {
  vi.mocked(callJsonOutput).mockReset();
});

describe('detailed customer intent deterministic fallback', () => {
  test('maps available product requests', () => {
    expect(
      classifyCustomerIntentDeterministic({
        text: 'Show me available products',
        currentState: 'AWAITING_NEW_PRODUCT',
      }).intent,
    ).toBe('SHOW_AVAILABLE_PRODUCTS');
  });

  test('maps Hinglish more options request', () => {
    expect(
      classifyCustomerIntentDeterministic({
        text: 'aur options dikhao',
        currentState: 'AWAITING_NEW_PRODUCT',
      }).intent,
    ).toBe('ASK_MORE_OPTIONS');
  });

  test('maps size-specific product request', () => {
    const result = classifyCustomerIntentDeterministic({
      text: '38 size mein kya hai',
      currentState: 'AWAITING_NEW_PRODUCT',
    });

    expect(result.intent).toBe('SHOW_PRODUCTS_BY_SIZE');
    expect(result.size).toBe('38');
  });

  test('maps No during product confirmation to reject product', () => {
    expect(
      classifyCustomerIntentDeterministic({
        text: 'No',
        currentState: 'AWAITING_PRODUCT_CONFIRMATION',
        lastBotWasProductConfirmation: true,
      }).intent,
    ).toBe('REJECT_PRODUCT');
  });

  test('maps Hinglish rejection to reject product', () => {
    expect(
      classifyCustomerIntentDeterministic({
        text: 'ye nahi chahiye',
        currentState: 'AWAITING_PRODUCT_CONFIRMATION',
        lastBotWasProductConfirmation: true,
      }).intent,
    ).toBe('REJECT_PRODUCT');
  });

  test('maps numeric reply after available list to list selection', () => {
    const result = classifyCustomerIntentDeterministic({
      text: '1',
      currentState: 'AWAITING_NEW_PRODUCT',
      availableProductListShown: true,
    });

    expect(result.intent).toBe('SELECT_PRODUCT_FROM_LIST');
    expect(result.selectedIndex).toBe(1);
  });

  test('falls back safely when Gemini intent classification fails', async () => {
    const originalKey = env.GEMINI_API_KEY;
    env.GEMINI_API_KEY = 'test-key';
    vi.mocked(callJsonOutput).mockRejectedValueOnce(new Error('Gemini unavailable'));

    try {
      const result = await classifyCustomerIntent({
        text: 'Show me available products',
        currentState: 'AWAITING_NEW_PRODUCT',
      });

      expect(result.intent).toBe('SHOW_AVAILABLE_PRODUCTS');
      expect(result.confidence).toBeGreaterThan(0);
    } finally {
      env.GEMINI_API_KEY = originalKey;
    }
  });
});
