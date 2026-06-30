import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kda/db', () => ({ prisma: { dashboardNotification: { create: vi.fn(async () => ({ id: 'n1' })) } } }));
vi.mock('../realtime/io', () => ({ emitToDashboard: vi.fn() }));
vi.mock('../whatsapp/alertClient', () => ({ sendOwnerAlertTemplate: vi.fn(async () => ({ ok: true })) }));

import { prisma } from '@kda/db';
import { emitToDashboard } from '../realtime/io';
import { sendOwnerAlertTemplate } from '../whatsapp/alertClient';
import { env } from '../config/env';
import { __resetEscalationStateForTests, escalateToOwner, maskCustomerNumber } from './escalation';

const base = { conversationId: 'conv1', customerWhatsappNumber: '919254100603', reason: 'NO_MATCH' as const };

beforeEach(() => {
  vi.clearAllMocks();
  __resetEscalationStateForTests();
  vi.mocked(sendOwnerAlertTemplate).mockResolvedValue({ ok: true });
  env.ALERT_ENABLED = true;
  env.ALERT_DEBOUNCE_MINUTES = 10;
  env.ALERT_RECIPIENT_NUMBER = '919254100603';
  env.ALERT_TEMPLATE_NAME = 'owner_photo_escalation';
  env.ALERT_TEMPLATE_LANGUAGE = 'en';
  env.PUBLIC_DASHBOARD_URL = 'https://dash.example.com';
});
afterEach(() => {
  env.ALERT_ENABLED = false;
  __resetEscalationStateForTests();
});

describe('maskCustomerNumber', () => {
  test('keeps only the last 4 digits', () => {
    expect(maskCustomerNumber('919254100603')).toBe('••••••0603');
    expect(maskCustomerNumber('+91 92541 00603')).toBe('••••••0603');
  });
});

describe('escalateToOwner', () => {
  test('NO_MATCH → dashboard queue (persist + emit) AND debounced owner alert', async () => {
    await escalateToOwner(base);

    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(1);
    const row = vi.mocked(prisma.dashboardNotification.create).mock.calls[0]![0].data as Record<string, any>;
    expect(row.type).toBe('PHOTO_ESCALATION');
    expect(row.metadata.reason).toBe('NO_MATCH');
    expect(row.metadata.customerMasked).toBe('••••••0603');
    expect(emitToDashboard).toHaveBeenCalledWith('photo_escalation', expect.objectContaining({ reason: 'NO_MATCH', customerMasked: '••••••0603' }));

    expect(sendOwnerAlertTemplate).toHaveBeenCalledTimes(1);
    const alert = vi.mocked(sendOwnerAlertTemplate).mock.calls[0]![0];
    expect(alert.bodyParams).toEqual(['••••••0603', 'NO_MATCH', 'https://dash.example.com/conversations/conv1']);
  });

  test('CUSTOMER_REJECTED reason flows through to queue + alert', async () => {
    await escalateToOwner({ ...base, reason: 'CUSTOMER_REJECTED', imageUrl: '/uploads/wrong.jpg' });
    expect(vi.mocked(sendOwnerAlertTemplate).mock.calls[0]![0].bodyParams[1]).toBe('CUSTOMER_REJECTED');
    const row = vi.mocked(prisma.dashboardNotification.create).mock.calls[0]![0].data as Record<string, any>;
    expect(row.metadata.imageUrl).toBe('/uploads/wrong.jpg');
  });

  test('debounce: repeated escalations in one conversation within the window send only ONE owner alert', async () => {
    await escalateToOwner(base);
    await escalateToOwner(base);
    await escalateToOwner(base);
    // Owner WhatsApp alert debounced to 1…
    expect(sendOwnerAlertTemplate).toHaveBeenCalledTimes(1);
    // …but every escalation still records to the dashboard queue.
    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(3);
  });

  test('a DIFFERENT conversation is alerted independently (debounce is per-conversation)', async () => {
    await escalateToOwner(base);
    await escalateToOwner({ ...base, conversationId: 'conv2' });
    expect(sendOwnerAlertTemplate).toHaveBeenCalledTimes(2);
  });

  test('ALERT_ENABLED=false → NO WhatsApp send, dashboard queue still records (fallback)', async () => {
    env.ALERT_ENABLED = false;
    await escalateToOwner(base);
    expect(sendOwnerAlertTemplate).not.toHaveBeenCalled();
    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(1);
    expect(emitToDashboard).toHaveBeenCalled();
  });

  test('alert send failure does NOT throw and dashboard queue still recorded', async () => {
    vi.mocked(sendOwnerAlertTemplate).mockResolvedValue({ ok: false, reason: 'send_failed' });
    await expect(escalateToOwner(base)).resolves.toBeUndefined();
    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(1);
  });

  test('dashboard persistence failure does NOT throw (flow continues)', async () => {
    vi.mocked(prisma.dashboardNotification.create).mockRejectedValueOnce(new Error('db down'));
    await expect(escalateToOwner(base)).resolves.toBeUndefined();
    // Still emits the live event + attempts the owner alert.
    expect(emitToDashboard).toHaveBeenCalled();
    expect(sendOwnerAlertTemplate).toHaveBeenCalledTimes(1);
  });
});
