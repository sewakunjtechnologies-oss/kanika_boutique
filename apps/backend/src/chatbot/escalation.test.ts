import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@kda/db', () => ({ prisma: { dashboardNotification: { create: vi.fn(async () => ({ id: 'n1' })) } } }));
vi.mock('../realtime/io', () => ({ emitToDashboard: vi.fn() }));

import { prisma } from '@kda/db';
import { emitToDashboard } from '../realtime/io';
import { env } from '../config/env';
import { escalateToOwner, maskCustomerNumber } from './escalation';

const base = { conversationId: 'conv1', customerWhatsappNumber: '919254100603', reason: 'NO_MATCH' as const };

beforeEach(() => {
  vi.clearAllMocks();
  env.PUBLIC_DASHBOARD_URL = 'https://dash.example.com';
});
afterEach(() => vi.clearAllMocks());

describe('maskCustomerNumber', () => {
  test('keeps only the last 4 digits', () => {
    expect(maskCustomerNumber('919254100603')).toBe('••••••0603');
    expect(maskCustomerNumber('+91 92541 00603')).toBe('••••••0603');
  });
});

describe('escalateToOwner — persist + emit (no WhatsApp)', () => {
  test('NO_MATCH → persists a DashboardNotification AND emits escalation_created', async () => {
    await escalateToOwner(base);

    expect(prisma.dashboardNotification.create).toHaveBeenCalledTimes(1);
    const row = vi.mocked(prisma.dashboardNotification.create).mock.calls[0]![0].data as Record<string, any>;
    expect(row.type).toBe('PHOTO_ESCALATION');
    expect(row.entityId).toBe('conv1');
    expect(row.metadata.reason).toBe('NO_MATCH');
    expect(row.metadata.customerMasked).toBe('••••••0603');
    expect(row.metadata.conversationLink).toBe('https://dash.example.com/conversations?id=conv1');

    expect(emitToDashboard).toHaveBeenCalledWith(
      'escalation_created',
      expect.objectContaining({ conversationId: 'conv1', reason: 'NO_MATCH', customerMasked: '••••••0603' }),
    );
  });

  test('CUSTOMER_REJECTED carries the (wrong) image url through', async () => {
    await escalateToOwner({ ...base, reason: 'CUSTOMER_REJECTED', imageUrl: '/uploads/wrong.jpg' });
    const row = vi.mocked(prisma.dashboardNotification.create).mock.calls[0]![0].data as Record<string, any>;
    expect(row.metadata.reason).toBe('CUSTOMER_REJECTED');
    expect(row.metadata.imageUrl).toBe('/uploads/wrong.jpg');
    expect(emitToDashboard).toHaveBeenCalledWith('escalation_created', expect.objectContaining({ reason: 'CUSTOMER_REJECTED' }));
  });

  test('never logs/persists the full customer number (masked only)', async () => {
    await escalateToOwner(base);
    const json = JSON.stringify(vi.mocked(prisma.dashboardNotification.create).mock.calls[0]![0]);
    expect(json).not.toContain('919254100603');
  });

  test('persistence failure does NOT throw and still emits the live event', async () => {
    vi.mocked(prisma.dashboardNotification.create).mockRejectedValueOnce(new Error('db down'));
    await expect(escalateToOwner(base)).resolves.toBeUndefined();
    expect(emitToDashboard).toHaveBeenCalledTimes(1);
  });
});
