import { describe, expect, test } from 'vitest';
import { isManagerOrOwnerRole, isOwnerRole } from './middleware';

describe('role permissions', () => {
  test('owner and legacy admin can approve orders', () => {
    expect(isOwnerRole('OWNER')).toBe(true);
    expect(isOwnerRole('ADMIN')).toBe(true);
  });

  test('manager and staff cannot approve orders', () => {
    expect(isOwnerRole('MANAGER')).toBe(false);
    expect(isOwnerRole('STAFF')).toBe(false);
  });

  test('manager and staff cannot approve or reject payment reviews', () => {
    expect(isOwnerRole('MANAGER')).toBe(false);
    expect(isOwnerRole('STAFF')).toBe(false);
  });

  test('owner and manager can create manual receipts', () => {
    expect(isManagerOrOwnerRole('OWNER')).toBe(true);
    expect(isManagerOrOwnerRole('ADMIN')).toBe(true);
    expect(isManagerOrOwnerRole('MANAGER')).toBe(true);
    expect(isManagerOrOwnerRole('STAFF')).toBe(false);
  });
});
