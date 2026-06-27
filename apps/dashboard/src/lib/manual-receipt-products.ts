export interface ManualReceiptProductVariant {
  id: string;
  size: string;
  stock: number;
  priceOverride: string | null;
}

export interface ManualReceiptProduct {
  id: string;
  name: string | null;
  sku: string;
  category?: string | null;
  imageUrl?: string | null;
  basePrice: string;
  isActive?: boolean;
  totalStock?: number;
  variants: ManualReceiptProductVariant[];
}

export function productDisplayName(product: ManualReceiptProduct): string {
  return product.name?.trim() || 'Unnamed product';
}

export function productTotalStock(product: ManualReceiptProduct): number {
  if (typeof product.totalStock === 'number') return product.totalStock;
  return product.variants.reduce((sum, variant) => sum + Math.max(variant.stock, 0), 0);
}

export function productAvailableSizes(product: ManualReceiptProduct): string[] {
  return Array.from(
    new Set(
      product.variants
        .filter((variant) => variant.stock > 0)
        .map((variant) => variant.size)
        .filter(Boolean),
    ),
  );
}

export function isSelectableReceiptProduct(product: ManualReceiptProduct): boolean {
  return product.isActive !== false && productTotalStock(product) > 0;
}

export function findDefaultVariant(product: ManualReceiptProduct): ManualReceiptProductVariant | undefined {
  return product.variants.find((variant) => variant.stock > 0) ?? product.variants[0];
}

export function productSearchText(product: ManualReceiptProduct): string {
  return [
    product.name,
    product.sku,
    product.category,
    productAvailableSizes(product).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function filterReceiptProducts(
  products: ManualReceiptProduct[],
  query: string,
): ManualReceiptProduct[] {
  const normalized = query.trim().toLowerCase();
  return products
    .filter((product) => product.isActive !== false)
    .filter((product) => !normalized || productSearchText(product).includes(normalized));
}
