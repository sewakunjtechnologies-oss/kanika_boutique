// Central source of truth for whether a product is customer-size-selectable
// (SIZED) or sold as one Free Size piece (FREE_SIZE).
//
// BUSINESS RULE (non-negotiable): an unstitched suit must NEVER ask the customer
// to pick a size, regardless of whatever legacy size variant rows exist in the
// database (numeric sizes, a default row, mixed legacy data, etc.). The business
// rule overrides inconsistent legacy variant data. See resolveProductSizeMode.

export type SizeMode = 'SIZED' | 'FREE_SIZE';

/** Canonical value persisted in conversation context + used for routing. */
export const FREE_SIZE_CANONICAL = 'FREE_SIZE';
/** Customer-facing + receipt display value. */
export const FREE_SIZE_DISPLAY = 'Free Size';

export interface ResolvedSizeMode {
  sizeMode: SizeMode;
  requiresSizeSelection: boolean;
  /** Canonical size to store when the customer never picks one (FREE_SIZE), else null. */
  selectedDefaultSize: string | null;
  /** Where orderable stock comes from. The schema only has variant-level stock today. */
  stockSource: 'variant';
  reason: string;
}

export interface SizeModeProductInput {
  category?: string | null;
  /** Optional stable category slug (Category.slug) — preferred over the free-text name. */
  categorySlug?: string | null;
  /** Optional explicit override field, should the schema ever gain one. Highest priority. */
  sizeMode?: string | null;
}

const UNSTITCHED_HINT = /unstitched|free[\s_-]?size/;
const STITCHED_HINT = /\bstitched\b/; // "stitched" without the "un" prefix

/**
 * True when a product (by category name or slug) is an unstitched / free-size product.
 * Normalizes all of: "unstitched", "unstitched suit(s)", "unstitched-suit(s)",
 * "free size", "free-size".
 */
export function isUnstitchedCategory(category?: string | null, slug?: string | null): boolean {
  const haystack = `${category ?? ''} ${slug ?? ''}`.toLowerCase();
  if (!haystack.trim()) return false;
  // "unstitched..." contains "stitched" as a substring, so test the unstitched hint
  // first and only treat as stitched when the unstitched hint is absent.
  if (UNSTITCHED_HINT.test(haystack)) return true;
  return false;
}

/**
 * Resolve the authoritative size mode for a product. Pure + side-effect free so it
 * is trivially unit-testable and can be called from the orchestrator, order
 * service and label builder alike.
 */
export function resolveProductSizeMode(product: SizeModeProductInput): ResolvedSizeMode {
  // 1. Explicit override field wins if a future schema provides one.
  const explicit = (product.sizeMode ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (explicit === 'FREE_SIZE') {
    return freeSize('explicit_size_mode_field');
  }
  if (explicit === 'SIZED') {
    return sized('explicit_size_mode_field');
  }

  // 2. Stable category slug / free-text category name.
  if (isUnstitchedCategory(product.category, product.categorySlug)) {
    return freeSize('category_unstitched');
  }
  return sized('category_sized');
}

function freeSize(reason: string): ResolvedSizeMode {
  return {
    sizeMode: 'FREE_SIZE',
    requiresSizeSelection: false,
    selectedDefaultSize: FREE_SIZE_CANONICAL,
    stockSource: 'variant',
    reason,
  };
}

function sized(reason: string): ResolvedSizeMode {
  return {
    sizeMode: 'SIZED',
    requiresSizeSelection: true,
    selectedDefaultSize: null,
    stockSource: 'variant',
    reason,
  };
}

export interface SizeModeVariant {
  id: string;
  size: string;
  stock: number;
}

/**
 * Pick the single canonical variant a FREE_SIZE order should attach to. The
 * customer never chose a size, so we deterministically select one in-stock
 * variant regardless of its (possibly legacy/numeric) size label:
 *   1. prefer a variant whose size already reads as a free-size label,
 *   2. otherwise the in-stock variant with the most stock (ties → first by id
 *      for determinism).
 * Returns null only when no in-stock variant exists.
 */
export function pickFreeSizeVariant<T extends SizeModeVariant>(variants: T[]): T | null {
  const inStock = variants.filter((v) => v.stock > 0);
  if (inStock.length === 0) return null;
  const freeSizeLabelled = inStock
    .filter((v) => /free[\s_-]?size|^fs$|^free$/i.test(v.size.trim()))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (freeSizeLabelled.length > 0) return freeSizeLabelled[0] as T;
  return [...inStock].sort((a, b) => b.stock - a.stock || a.id.localeCompare(b.id))[0] as T;
}

/** Resolve the size string to print/display given a product's size mode. */
export function displaySizeFor(mode: SizeMode, rawSize?: string | null): string {
  if (mode === 'FREE_SIZE') return FREE_SIZE_DISPLAY;
  const trimmed = (rawSize ?? '').trim();
  return trimmed.length > 0 ? trimmed : '-';
}

// Re-exported for callers that only need the stitched hint (e.g. diagnostics).
export const _STITCHED_HINT = STITCHED_HINT;
