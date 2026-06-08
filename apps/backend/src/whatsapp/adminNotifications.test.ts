import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';
import { sendText } from './client';
import {
  buildPaymentApprovalMessage,
  getAdminWhatsappNumbers,
  notifyAdminsPaymentPending,
  parseAdminNumbers,
  shouldSendAdminNotification,
} from './adminNotifications';

vi.mock('./client', () => ({
  sendText: vi.fn(),
}));

const OK = { ok: true as const, wamid: 'wamid', conversationId: 'conv' };

const originalOwner = env.OWNER_WHATSAPP_NUMBER;
const originalAdmins = env.ADMIN_WHATSAPP_NUMBERS;
const originalDashboard = env.PUBLIC_DASHBOARD_URL;

beforeEach(() => {
  vi.mocked(sendText).mockReset();
  vi.mocked(sendText).mockResolvedValue(OK);
  env.OWNER_WHATSAPP_NUMBER = '919876543210';
  env.ADMIN_WHATSAPP_NUMBERS = '';
  env.PUBLIC_DASHBOARD_URL = 'https://shop.example.com';
});

afterEach(() => {
  env.OWNER_WHATSAPP_NUMBER = originalOwner;
  env.ADMIN_WHATSAPP_NUMBERS = originalAdmins;
  env.PUBLIC_DASHBOARD_URL = originalDashboard;
});

const sampleInput = {
  orderId: 'order_123',
  orderNumber: 'ORD-2026-0001',
  amount: '2270',
  customerName: 'Anita',
  customerPhone: '919812345678',
  productName: 'Blue Floral Pure Cotton Suit',
  utr: 'UTR998877',
};

describe('parseAdminNumbers', () => {
  test('combines owner + admin numbers, dedupes, strips formatting', () => {
    expect(parseAdminNumbers('919876543210', '+91 99999 88888, 919876543210')).toEqual([
      '919876543210',
      '919999988888',
    ]);
  });

  test('returns empty list when nothing configured', () => {
    expect(parseAdminNumbers('', '')).toEqual([]);
    expect(parseAdminNumbers(undefined, undefined)).toEqual([]);
  });

  test('getAdminWhatsappNumbers reads from env', () => {
    env.ADMIN_WHATSAPP_NUMBERS = '919811111111';
    expect(getAdminWhatsappNumbers()).toEqual(['919876543210', '919811111111']);
  });
});

describe('shouldSendAdminNotification (dedup guard)', () => {
  test('true when never notified, false once notified', () => {
    expect(shouldSendAdminNotification(null)).toBe(true);
    expect(shouldSendAdminNotification(undefined)).toBe(true);
    expect(shouldSendAdminNotification(new Date())).toBe(false);
    expect(shouldSendAdminNotification('2026-06-08T00:00:00.000Z')).toBe(false);
  });
});

describe('buildPaymentApprovalMessage', () => {
  test('includes order details and the direct dashboard order link', () => {
    const body = buildPaymentApprovalMessage(sampleInput);
    expect(body).toContain('🔔 Payment approval needed');
    expect(body).toContain('Order: #ORD-2026-0001');
    expect(body).toContain('Customer: Anita / 919812345678');
    expect(body).toContain('Product: Blue Floral Pure Cotton Suit');
    expect(body).toContain('Amount: ₹2270');
    expect(body).toContain('Extracted UTR: UTR998877');
    expect(body).toContain('Status: Pending approval');
    expect(body).toContain('https://shop.example.com/orders/order_123');
  });

  test('falls back to "Not detected" when UTR missing', () => {
    expect(buildPaymentApprovalMessage({ ...sampleInput, utr: null })).toContain(
      'Extracted UTR: Not detected',
    );
  });
});

describe('notifyAdminsPaymentPending', () => {
  test('notifies every configured admin with the dashboard link', async () => {
    env.ADMIN_WHATSAPP_NUMBERS = '919811111111';
    const result = await notifyAdminsPaymentPending(sampleInput);

    expect(result).toEqual({ attempted: 2, sent: 2 });
    expect(sendText).toHaveBeenCalledTimes(2);
    const [firstTo, firstBody] = vi.mocked(sendText).mock.calls[0]!;
    expect(firstTo).toBe('919876543210');
    expect(firstBody).toContain('https://shop.example.com/orders/order_123');
  });

  test('no recipients configured → no sends, attempted 0', async () => {
    env.OWNER_WHATSAPP_NUMBER = '';
    env.ADMIN_WHATSAPP_NUMBERS = '';
    const result = await notifyAdminsPaymentPending(sampleInput);

    expect(result).toEqual({ attempted: 0, sent: 0 });
    expect(sendText).not.toHaveBeenCalled();
  });

  test('a failing send does not crash and does not block other admins', async () => {
    env.ADMIN_WHATSAPP_NUMBERS = '919811111111';
    vi.mocked(sendText)
      .mockRejectedValueOnce(new Error('graph down'))
      .mockResolvedValueOnce(OK);

    const result = await notifyAdminsPaymentPending(sampleInput);

    expect(result.attempted).toBe(2);
    expect(result.sent).toBe(1);
  });

  test('a rejected (not-ok) outcome is counted as not sent but never throws', async () => {
    vi.mocked(sendText).mockResolvedValue({ ok: false, reason: 'graph_error' });
    const result = await notifyAdminsPaymentPending(sampleInput);
    expect(result).toEqual({ attempted: 1, sent: 0 });
  });
});
