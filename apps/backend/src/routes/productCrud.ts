/**
 * Pure, dependency-free helpers for product CRUD decisions so the read/delete
 * policy can be unit-tested without an HTTP server.
 */

export type ProductListStatus = 'active' | 'archived' | 'all';
export type ProductDeletionAction = 'deleted' | 'archived';

/**
 * Prisma `where` fragment for the product list. Active inventory is the default;
 * archived (soft-deleted, isActive=false) products are excluded so they never
 * appear in the dashboard list, the manual-receipt selector or matching.
 */
export function productListStatusWhere(status: string | undefined): { isActive?: boolean } {
  if (status === 'archived') return { isActive: false };
  if (status === 'all') return {};
  return { isActive: true };
}

/**
 * Delete strategy: hard-delete only an unreferenced product on an explicit hard
 * request; otherwise archive (soft delete) to preserve order/receipt history.
 */
export function decideProductDeletion(input: { hard: boolean; isReferenced: boolean }): ProductDeletionAction {
  return input.hard && !input.isReferenced ? 'deleted' : 'archived';
}
