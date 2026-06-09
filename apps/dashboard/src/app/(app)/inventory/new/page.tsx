'use client';

import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ProductForm } from '@/components/product-form';
import { api } from '@/lib/api';

export default function NewProductPage(): React.ReactElement {
  const router = useRouter();
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Add product</h1>
      <ProductForm
        submitLabel="Create product"
        onSubmit={async (draft) => {
          await api.post('/api/products', {
            sku: draft.sku,
            name: draft.name,
            description: draft.description,
            category: draft.category,
            categoryId: draft.categoryId || null,
            basePrice: Number(draft.basePrice),
            imageUrl: draft.imageUrl,
            imagePublicId: draft.imagePublicId || undefined,
            isActive: draft.isActive,
            variants: draft.variants
              .filter((v) => v.size)
              .map((v) => ({
                size: v.size,
                color: v.color || null,
                stock: v.stock,
                priceOverride: v.priceOverride ? Number(v.priceOverride) : null,
              })),
          });
          toast.success('Product created');
          router.push('/inventory');
        }}
      />
    </div>
  );
}
