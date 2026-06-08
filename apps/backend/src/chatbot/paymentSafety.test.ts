import { describe, expect, test } from 'vitest';
import { buildPaymentReviewWarnings } from './paymentSafety';

describe('payment safety warnings', () => {
  const base = {
    orderId: 'order_1',
    expectedAmount: 2500,
    expectedReceiverUpi: 'kanika@upi',
    extractedAmount: 2500,
    extractedReceiver: 'kanika@upi',
    extractedUtr: '123456789012',
    looksLegitimate: true,
    duplicateUtr: false,
  };

  test('returns no warnings for a matching payment', () => {
    expect(buildPaymentReviewWarnings(base)).toEqual([]);
  });

  test('warns on amount and receiver mismatch', () => {
    expect(
      buildPaymentReviewWarnings({
        ...base,
        extractedAmount: 2400,
        extractedReceiver: 'wrong@upi',
      }),
    ).toEqual(expect.arrayContaining(['amount_mismatch', 'receiver_mismatch']));
  });

  test('warns on duplicate UTR and suspicious screenshot', () => {
    expect(
      buildPaymentReviewWarnings({
        ...base,
        duplicateUtr: true,
        looksLegitimate: false,
      }),
    ).toEqual(expect.arrayContaining(['duplicate_utr', 'screenshot_suspicious']));
  });
});
