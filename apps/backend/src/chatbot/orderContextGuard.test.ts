import { describe, expect, test } from 'vitest';
import { ConversationState, OrderStatus } from '@kda/db';
import {
  clearPausedContextOnRelease,
  hasBotPausedReason,
  isOrderStatusActiveForConversation,
  pausedContext,
  readOrderContext,
  stateRequiresPersistedOrder,
} from './orderContextGuard';

describe('orderContextGuard', () => {
  test('treats unpaid/rejected orders as active conversation contexts', () => {
    expect(isOrderStatusActiveForConversation(OrderStatus.PENDING)).toBe(true);
    expect(isOrderStatusActiveForConversation(OrderStatus.PAYMENT_RECEIVED)).toBe(true);
    expect(isOrderStatusActiveForConversation(OrderStatus.PAYMENT_REVIEW)).toBe(true);
    expect(isOrderStatusActiveForConversation(OrderStatus.REJECTED)).toBe(true);
  });

  test('treats cancelled and fulfilled orders as closed conversation contexts', () => {
    expect(isOrderStatusActiveForConversation(OrderStatus.CANCELLED)).toBe(false);
    expect(isOrderStatusActiveForConversation(OrderStatus.VERIFIED)).toBe(false);
    expect(isOrderStatusActiveForConversation(OrderStatus.PRINTED)).toBe(false);
    expect(isOrderStatusActiveForConversation(OrderStatus.DISPATCHED)).toBe(false);
    expect(isOrderStatusActiveForConversation(OrderStatus.EXPIRED)).toBe(false);
  });

  test('requires a persisted order only in payment states', () => {
    expect(stateRequiresPersistedOrder(ConversationState.AWAITING_PAYMENT)).toBe(true);
    expect(stateRequiresPersistedOrder(ConversationState.AWAITING_PAYMENT_SCREENSHOT)).toBe(true);
    expect(stateRequiresPersistedOrder(ConversationState.AWAITING_VERIFICATION)).toBe(true);
    expect(stateRequiresPersistedOrder(ConversationState.AWAITING_QTY)).toBe(false);
    expect(stateRequiresPersistedOrder(ConversationState.IDLE)).toBe(false);
  });

  test('detects and clears bot pause marker on manual release', () => {
    const paused = pausedContext('customer_cancelled');
    expect(hasBotPausedReason(paused)).toBe(true);
    expect(clearPausedContextOnRelease(paused)).toEqual({
      state: ConversationState.IDLE,
      contextJson: {},
    });
    expect(clearPausedContextOnRelease({ orderId: 'order_1' })).toEqual({});
  });

  test('normalizes invalid context json to an empty order context', () => {
    expect(readOrderContext(null)).toEqual({});
    expect(readOrderContext('bad')).toEqual({});
    expect(readOrderContext({ orderId: 'order_1' })).toEqual({ orderId: 'order_1' });
  });
});
