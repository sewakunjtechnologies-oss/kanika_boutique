import { describe, expect, test } from 'vitest';
import { OrderStatus } from '@kda/db';
import { stickerPrintValidationError, describeStickerPrintFailure } from './orders';

// Regression for the print-sticker 500: the endpoint now enqueues an ORDER_LABEL
// PrintJob (bridge path) instead of the legacy PrintNode/PDF flow, and reports a
// reasoned error instead of an opaque "print_failed". These cover the branch
// logic without an HTTP harness (same style as productCrud.test.ts).

describe('stickerPrintValidationError', () => {
  test('missing order → 404 not_found', () => {
    expect(stickerPrintValidationError(null)).toEqual({ status: 404, body: { error: 'not_found' } });
  });

  test('non-printable status → 409 invalid_status_transition', () => {
    expect(stickerPrintValidationError({ status: OrderStatus.PAYMENT_RECEIVED, shippingAddress: 'House 5' })).toEqual({
      status: 409,
      body: { error: 'invalid_status_transition', action: 'print_sticker', status: OrderStatus.PAYMENT_RECEIVED },
    });
  });

  test('blank address → 409 missing_address', () => {
    expect(stickerPrintValidationError({ status: OrderStatus.VERIFIED, shippingAddress: '   ' })).toEqual({
      status: 409,
      body: { error: 'missing_address' },
    });
  });

  test('approved (VERIFIED) order with address → proceeds (null, will enqueue)', () => {
    expect(stickerPrintValidationError({ status: OrderStatus.VERIFIED, shippingAddress: 'House 5, Panipat' })).toBeNull();
  });

  test('already PRINTED order with address → proceeds (reprint allowed)', () => {
    expect(stickerPrintValidationError({ status: OrderStatus.PRINTED, shippingAddress: 'House 5' })).toBeNull();
  });
});

describe('describeStickerPrintFailure', () => {
  test('Error → reasoned print_failed carrying the message + errorId', () => {
    expect(describeStickerPrintFailure(new Error('order o1 not found'), 'sticker_abc')).toEqual({
      error: 'print_failed',
      reason: 'order o1 not found',
      errorId: 'sticker_abc',
    });
  });

  test('non-Error throwable → generic reason, still not opaque', () => {
    expect(describeStickerPrintFailure('boom', 'sticker_xyz')).toEqual({
      error: 'print_failed',
      reason: 'unknown error',
      errorId: 'sticker_xyz',
    });
  });
});
