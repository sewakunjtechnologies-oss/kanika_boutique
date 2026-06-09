'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Trash2, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ProductForm, type VariantDraft } from '@/components/product-form';
import { api, ApiError } from '@/lib/api';

interface ProductDetail {
  id: string;
  sku: string;
  name: string;
  description: string;
  category: string;
  categoryId: string | null;
  basePrice: string;
  imageUrl: string;
  imagePublicId: string | null;
  isActive: boolean;
  variants: {
    id: string;
    size: string;
    color: string | null;
    stock: number;
    priceOverride: string | null;
  }[];
}

export default function EditProductPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    const r = await api.get<{ product: ProductDetail }>(`/api/products/${params.id}`);
    setProduct(r.product);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!product) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  async function syncVariants(
    draftVariants: VariantDraft[],
    original: ProductDetail['variants'],
  ): Promise<void> {
    const draftIds = new Set(draftVariants.filter((v) => v.id).map((v) => v.id as string));

    // 1) Delete variants present in the original but missing from the draft.
    for (const orig of original) {
      if (!draftIds.has(orig.id)) {
        await api.delete(`/api/variants/${orig.id}`);
      }
    }

    // 2) Update existing + 3) create new.
    for (const v of draftVariants) {
      if (!v.size) continue;
      const payload = {
        size: v.size,
        color: v.color || null,
        stock: Number(v.stock),
        priceOverride: v.priceOverride ? Number(v.priceOverride) : null,
      };
      if (v.id) {
        await api.put(`/api/variants/${v.id}`, payload);
      } else {
        await api.post(`/api/products/${product!.id}/variants`, payload);
      }
    }
  }

  async function deactivate(): Promise<void> {
    if (!confirm('Hide this product (soft delete)? It can be reactivated by editing it.')) return;
    setBusy(true);
    try {
      await api.delete(`/api/products/${product!.id}`);
      toast.success('Product deactivated');
      router.push('/inventory');
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete(): Promise<void> {
    if (
      !confirm(
        'Permanently DELETE this product and all its variants? This cannot be undone. If any variant has been ordered, the product will be deactivated instead.',
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const r = await api.delete<{ mode: 'hard' | 'soft_fallback'; reason?: string }>(
        `/api/products/${product!.id}?hard=true`,
      );
      if (r.mode === 'hard') toast.success('Product permanently deleted');
      else toast.warning(r.reason ?? 'Product has order history — deactivated instead.');
      router.push('/inventory');
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body);
      else toast.error('Delete failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Edit product</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={deactivate} disabled={busy}>
            <EyeOff size={14} className="mr-2" /> Deactivate
          </Button>
          <Button variant="destructive" onClick={hardDelete} disabled={busy}>
            <Trash2 size={14} className="mr-2" /> Delete
          </Button>
        </div>
      </div>
      <ProductForm
        submitLabel="Save changes"
        initial={{
          sku: product.sku,
          name: product.name,
          description: product.description,
          category: product.category,
          categoryId: product.categoryId ?? '',
          basePrice: product.basePrice,
          imageUrl: product.imageUrl,
          imagePublicId: product.imagePublicId ?? '',
          isActive: product.isActive,
          variants: product.variants.map((v) => ({
            id: v.id,
            size: v.size,
            color: v.color ?? '',
            stock: v.stock,
            priceOverride: v.priceOverride ?? '',
          })),
        }}
        onSubmit={async (draft) => {
          // 1) Update product fields.
          await api.put(`/api/products/${product.id}`, {
            sku: draft.sku,
            name: draft.name,
            description: draft.description,
            category: draft.category,
            categoryId: draft.categoryId || null,
            basePrice: Number(draft.basePrice),
            imageUrl: draft.imageUrl,
            imagePublicId: draft.imagePublicId || undefined,
            isActive: draft.isActive,
          });
          // 2) Sync variants (add new, update existing, delete removed).
          await syncVariants(draft.variants, product.variants);
          await reload();
          toast.success('Saved');
        }}
      />
    </div>
  );
}
