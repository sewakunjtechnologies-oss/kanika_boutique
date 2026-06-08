// Cross-package zod schemas, constants, and types live here.
// Populated as later phases need shared validation between backend and dashboard.

export const PACKAGE_VERSION = '0.1.0';

export function calculateDeliveryCharge(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  const pieces = Math.floor(quantity);
  return 100 + (pieces - 1) * 50;
}
