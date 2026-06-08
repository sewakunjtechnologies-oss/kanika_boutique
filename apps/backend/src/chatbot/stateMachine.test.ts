import { describe, expect, test } from 'vitest';
import { ConversationState } from '@kda/db';
import {
  CANCEL_OR_CHANGE_MESSAGE,
  NEW_PRODUCT_REQUEST_MESSAGE,
  PRODUCT_FIRST_MESSAGE,
  PRODUCT_REJECTED_MESSAGE,
  transition,
  type OrderContext,
} from './stateMachine';

describe('stateMachine', () => {
  test('IDLE + image → AWAITING_PRODUCT_CONFIRMATION with RUN_PRODUCT_MATCH', () => {
    const r = transition(
      ConversationState.IDLE,
      { type: 'IMAGE', mediaId: 'media123' },
      {},
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_PRODUCT_CONFIRMATION);
    expect(r.actions.some((a) => a.type === 'RUN_PRODUCT_MATCH')).toBe(true);
  });

  test('IDLE + PRODUCT_MATCH_RESULT with match → AWAITING_SIZE', () => {
    const r = transition(
      ConversationState.IDLE,
      { type: 'PRODUCT_MATCH_RESULT', productId: 'prod123', alternativesNeeded: false },
      { productName: 'Blue Suit', productPrice: 1999, availableSizes: ['M', 'L'] },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_SIZE);
    expect(r.context.productId).toBe('prod123');
    expect(r.context.productName).toBe('Blue Suit');
    expect(r.context.productPrice).toBe(1999);
    expect(['SEND_BUTTONS', 'SEND_LIST']).toContain(r.actions[0]?.type);
  });

  test('AWAITING_SIZE + button reply → AWAITING_QTY with size in context', () => {
    const r = transition(
      ConversationState.AWAITING_SIZE,
      { type: 'BUTTON_REPLY', id: 'size_M', title: 'M' },
      { productId: 'prod123' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_QTY);
    expect(r.context.size).toBe('M');
  });

  test('AWAITING_QTY + valid number → AWAITING_NAME', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: '2' },
      { productId: 'prod123', size: 'M' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_NAME);
    expect(r.context.qty).toBe(2);
  });

  test('AWAITING_QTY + quantity phrase → AWAITING_NAME', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: 'Pieces 2' },
      { productId: 'prod123', size: 'M' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_NAME);
    expect(r.context.qty).toBe(2);
  });

  test('AWAITING_QTY + word quantity → AWAITING_NAME', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: 'two pieces' },
      { productId: 'prod123', size: 'M' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_NAME);
    expect(r.context.qty).toBe(2);
  });

  test('AWAITING_QTY + non-number → stays + asks again', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: 'many' },
      { productId: 'prod123', size: 'M' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_QTY);
    expect(r.actions[0]?.type).toBe('SEND_TEXT');
  });

  test('full happy path IDLE → ... → CREATE_ORDER', () => {
    let state: ConversationState = ConversationState.IDLE;
    let ctx: OrderContext = {};

    // Image arrives
    let r = transition(state, { type: 'IMAGE', mediaId: 'm1' }, ctx);
    state = r.nextState;
    ctx = r.context;

    // Product matched
    r = transition(
      state,
      { type: 'PRODUCT_MATCH_RESULT', productId: 'p1', alternativesNeeded: false },
      ctx,
    );
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_SIZE);

    // Size picked
    r = transition(state, { type: 'BUTTON_REPLY', id: 'size_L', title: 'L' }, ctx);
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_QTY);

    // Qty
    r = transition(state, { type: 'TEXT', body: '1' }, ctx);
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_NAME);

    // Name
    r = transition(state, { type: 'TEXT', body: 'Anita Sharma' }, ctx);
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_ADDRESS);

    // Address
    r = transition(state, { type: 'TEXT', body: 'H-12, Sector 5, Vaishali Nagar' }, ctx);
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_PINCODE);

    // Pincode + city + state
    r = transition(state, { type: 'TEXT', body: 'Jaipur, Rajasthan 302021' }, ctx);
    state = r.nextState;
    ctx = r.context;
    expect(state).toBe(ConversationState.AWAITING_PAYMENT);
    expect(r.actions[0]?.type).toBe('CREATE_ORDER');
  });

  test('AWAITING_PAYMENT + image → AWAITING_VERIFICATION with RUN_PAYMENT_EXTRACTION + NOTIFY_DASHBOARD', () => {
    const r = transition(
      ConversationState.AWAITING_PAYMENT,
      { type: 'IMAGE', mediaId: 'pay123' },
      { total: 2499 },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_VERIFICATION);
    expect(r.actions.some((a) => a.type === 'RUN_PAYMENT_EXTRACTION')).toBe(true);
    expect(r.actions.some((a) => a.type === 'NOTIFY_DASHBOARD')).toBe(true);
  });

  test('direct cancel command anywhere → resets to IDLE', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: 'cancel order' },
      { productId: 'p1', size: 'M' },
    );
    expect(r.nextState).toBe(ConversationState.IDLE);
    expect(r.context).toEqual({});
    expect(r.actions.some((a) => a.type === 'RESET_CONTEXT')).toBe(true);
    expect(r.actions.some((a) => a.type === 'MARK_HUMAN_TAKEOVER')).toBe(true);
  });

  test('yes → size prompt → change product clears product and asks new photo', () => {
    const r = transition(
      ConversationState.AWAITING_SIZE,
      { type: 'TEXT', body: 'Sorry no i want to change the product' },
      {
        productId: 'p1',
        productName: 'Article 1',
        productPrice: 2270,
        lastMatchedImageMediaId: 'old_media',
        availableSizes: ['40', '42'],
      },
    );

    expect(r.nextState).toBe(ConversationState.AWAITING_NEW_PRODUCT);
    expect(r.context.productId).toBeUndefined();
    expect(r.context.productRejected).toBe(true);
    expect(r.context.lastImageUsable).toBe(false);
    expect(r.context.awaitingNewProduct).toBe(true);
    expect(r.context.rejectedProductId).toBe('p1');
    expect(r.context.rejectedImageMediaId).toBe('old_media');
    expect(r.actions).toEqual([{ type: 'SEND_TEXT', body: NEW_PRODUCT_REQUEST_MESSAGE }]);
  });

  test('product confirmation + No clears selected product and sets rejected state', () => {
    const r = transition(
      ConversationState.AWAITING_PRODUCT_CONFIRMATION,
      { type: 'TEXT', body: 'No' },
      {
        productId: 'p1',
        productName: 'Article 1',
        productPrice: 2270,
        lastMatchedImageMediaId: 'old_media',
        availableSizes: ['38', '40'],
      },
    );

    expect(r.nextState).toBe(ConversationState.AWAITING_NEW_PRODUCT);
    expect(r.context.productId).toBeUndefined();
    expect(r.context.lastRejectedProductId).toBe('p1');
    expect(r.context.lastMatchedProductRejected).toBe(true);
    expect(r.context.lastImageUsable).toBe(false);
    expect(r.actions).toEqual([{ type: 'SEND_TEXT', body: PRODUCT_REJECTED_MESSAGE }]);
  });

  test('change product then cancel asks cancel/change clarification', () => {
    const changed = transition(
      ConversationState.AWAITING_SIZE,
      { type: 'TEXT', body: 'change product' },
      { productId: 'p1', lastMatchedImageMediaId: 'old_media' },
    );
    const r = transition(
      changed.nextState,
      { type: 'TEXT', body: 'Cancel' },
      changed.context,
    );

    expect(r.nextState).toBe(ConversationState.AWAITING_NEW_PRODUCT);
    expect(r.context.cancelClarificationPending).toBe(true);
    expect(r.actions).toEqual([{ type: 'SEND_TEXT', body: CANCEL_OR_CHANGE_MESSAGE }]);
  });

  test('after product-change, old image is not reusable in context', () => {
    const r = transition(
      ConversationState.AWAITING_QTY,
      { type: 'TEXT', body: 'different product' },
      { productId: 'p1', size: '40', qty: 2, lastMatchedImageMediaId: 'old_media' },
    );

    expect(r.context.lastImageUsable).toBe(false);
    expect(r.context.rejectedImageMediaId).toBe('old_media');
    expect(r.context.size).toBeUndefined();
    expect(r.context.qty).toBeUndefined();
  });

  test('new image in AWAITING_NEW_PRODUCT starts matching flow', () => {
    const r = transition(
      ConversationState.AWAITING_NEW_PRODUCT,
      { type: 'IMAGE', mediaId: 'new_media' },
      { productRejected: true, lastImageUsable: false, awaitingNewProduct: true, rejectedImageMediaId: 'old_media' },
    );

    expect(r.nextState).toBe(ConversationState.AWAITING_PRODUCT_CONFIRMATION);
    expect(r.context.lastMatchedImageMediaId).toBe('new_media');
    expect(r.context.lastImageUsable).toBe(true);
    expect(r.actions).toEqual([
      { type: 'SEND_TEXT', body: 'Got your new photo! Let me find this in our catalog...' },
      { type: 'RUN_PRODUCT_MATCH', mediaId: 'new_media' },
    ]);
  });

  test('text in AWAITING_NEW_PRODUCT asks for product first', () => {
    const r = transition(
      ConversationState.AWAITING_NEW_PRODUCT,
      { type: 'TEXT', body: 'yes' },
      { productRejected: true, lastImageUsable: false, awaitingNewProduct: true },
    );

    expect(r.nextState).toBe(ConversationState.AWAITING_NEW_PRODUCT);
    expect(r.actions).toEqual([{ type: 'SEND_TEXT', body: PRODUCT_FIRST_MESSAGE }]);
  });

  test('cancel phrase anywhere → releases bot to human takeover', () => {
    const r = transition(
      ConversationState.AWAITING_ADDRESS,
      { type: 'TEXT', body: 'nahi chahiye cancel order' },
      { productId: 'p1', size: 'M', qty: 1 },
    );
    expect(r.nextState).toBe(ConversationState.IDLE);
    expect(r.actions.some((a) => a.type === 'MARK_HUMAN_TAKEOVER')).toBe(true);
  });

  test('agent command anywhere → MARK_HUMAN_TAKEOVER', () => {
    const r = transition(
      ConversationState.AWAITING_PAYMENT,
      { type: 'TEXT', body: 'agent' },
      {},
    );
    expect(r.nextState).toBe(ConversationState.IDLE);
    expect(r.actions.some((a) => a.type === 'MARK_HUMAN_TAKEOVER')).toBe(true);
    expect(r.actions[0]?.type).toBe('SEND_TEXT');
  });

  test('menu command shows menu buttons', () => {
    const r = transition(
      ConversationState.AWAITING_SIZE,
      { type: 'TEXT', body: 'menu' },
      {},
    );
    expect(r.nextState).toBe(ConversationState.IDLE);
    const sendButtons = r.actions.find((a) => a.type === 'SEND_BUTTONS');
    expect(sendButtons).toBeDefined();
  });

  test('AWAITING_PINCODE + valid pincode parses city + state', () => {
    const r = transition(
      ConversationState.AWAITING_PINCODE,
      { type: 'TEXT', body: 'Mumbai Maharashtra 400001' },
      { productId: 'p1' },
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_PAYMENT);
    expect(r.context.pincode).toBe('400001');
    expect(r.context.city).toBe('Mumbai');
    expect(r.context.state).toContain('Maharashtra');
  });

  test('AWAITING_PINCODE + missing pincode → stays', () => {
    const r = transition(
      ConversationState.AWAITING_PINCODE,
      { type: 'TEXT', body: 'Mumbai Maharashtra' },
      {},
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_PINCODE);
  });

  test('AWAITING_VERIFICATION + any text → reassurance, no transition', () => {
    const r = transition(
      ConversationState.AWAITING_VERIFICATION,
      { type: 'TEXT', body: 'kya hua' },
      {},
    );
    expect(r.nextState).toBe(ConversationState.AWAITING_VERIFICATION);
    expect(r.actions[0]?.type).toBe('SEND_TEXT');
  });
});
