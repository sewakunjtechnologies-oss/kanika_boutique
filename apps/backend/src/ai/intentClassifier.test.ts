import { afterEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';
import { callJsonOutput } from './callJsonOutput';
import {
  classifyCustomerIntent,
  classifyCustomerIntentDeterministic,
  detectCustomerIntent,
} from './intentClassifier';

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

describe('WhatsApp bot trigger gate', () => {
  test.each([
    'hi',
    'hello',
    'hey',
    'hii',
    'good morning',
    'good evening',
    'thanks',
    'thank you',
    'ok',
    'okay',
    '👍',
    'hello ji',
    'hi mam',
    'price?',
    'random text',
  ])('does not trigger for %s', (message) => {
    expect(detectCustomerIntent(message).shouldTriggerBot).toBe(false);
  });

  test.each([
    ['Is this available?', 'availability'],
    ['Available?', 'availability'],
    ['Is this suit available or not?', 'availability'],
    ['Do you have this?', 'availability'],
    ['price and availability', 'availability'],
    ['ye available hai kya', 'availability'],
    ['available hai kya', 'availability'],
    ['ye suit available hai kya', 'availability'],
    ['क्या ये उपलब्ध है', 'availability'],
    ['I want to order this', 'order'],
    ['I want to order something', 'order'],
    ['Can I buy this?', 'order'],
    ['I want this suit', 'order'],
    ['Order this suit', 'order'],
    ['book this', 'order'],
    ['mujhe ye order karna hai', 'order'],
    ['मुझे ये सूट ऑर्डर करना है', 'order'],
    ['show me products', 'order'],
    ['more options', 'order'],
  ])('triggers %s as %s', (message, intent) => {
    const result = detectCustomerIntent(message);
    expect(result.shouldTriggerBot).toBe(true);
    expect(result.intent).toBe(intent);
  });
});
