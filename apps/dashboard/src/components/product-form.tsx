'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { api, BACKEND_BASE_URL } from '@/lib/api';

const DEFAULT_CATEGORIES = ['Co-ord Sets', 'Two-piece Kurtis', 'Three-piece Kurtis', 'Stitched Suits'];
const DEFAULT_SIZES = ['36', '38', '40', '42', '44', '46'];

interface CategoryOption {
  id: string;
  name: string;
  isActive: boolean;
}

export interface VariantDraft {
  /** DB id if this variant already exists, undefined for new rows. */
  id?: string;
  size: string;
  color: string;
  stock: number;
  priceOverride: string;
}

export interface ProductDraft {
  sku: string;
  name: string;
  description: string;
  category: string;
  categoryId: string;
  basePrice: string;
  imageUrl: string;
  imagePublicId: string;
  isActive: boolean;
  variants: VariantDraft[];
}

export function ProductForm({
  initial,
  onSubmit,
  submitLabel,
}: {
  initial?: Partial<ProductDraft>;
  onSubmit: (draft: ProductDraft) => Promise<void>;
  submitLabel: string;
}): React.ReactElement {
  const [draft, setDraft] = useState<ProductDraft>({
    sku: initial?.sku ?? '',
    name: initial?.name ?? '',
    description: initial?.description ?? '',
    category: initial?.category ?? 'Stitched Suits',
    categoryId: initial?.categoryId ?? '',
    basePrice: initial?.basePrice ?? '',
    imageUrl: initial?.imageUrl ?? '',
    imagePublicId: initial?.imagePublicId ?? '',
    isActive: initial?.isActive ?? true,
    variants: dynamicSizeVariants(initial?.variants),
  });
  const [saving, setSaving] = useState(false);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  // The selected photo is held as a File and uploaded on submit (not on select), so the
  // create is atomic: no orphaned uploads, no race where "Create" is clicked before an
  // on-select upload finishes. photoPreview is a local object URL for instant preview.
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);

  useEffect(() => {
    if (initial) {
      setDraft((d) => ({
        ...d,
        ...initial,
        categoryId: initial.categoryId ?? d.categoryId,
        variants: dynamicSizeVariants(initial.variants ?? d.variants),
      }));
    }
  }, [initial]);

  useEffect(() => {
    async function loadCategories(): Promise<void> {
      try {
        const r = await api.get<{ categories: CategoryOption[] }>('/api/categories');
        const active = r.categories.filter((category) => category.isActive);
        const nextCategories = active.length > 0 ? active : fallbackCategories();
        setCategories(nextCategories);
        setDraft((d) => {
          const current = nextCategories.find((category) => category.id === d.categoryId || category.name === d.category);
          return current && !d.categoryId
            ? { ...d, categoryId: current.id, category: current.name }
            : d;
        });
      } catch {
        setCategories(fallbackCategories());
      }
    }

    void loadCategories();
  }, []);

  // Revoke the previous object URL when the preview changes or the form unmounts.
  useEffect(() => {
    return () => {
      if (photoPreview) URL.revokeObjectURL(photoPreview);
    };
  }, [photoPreview]);

  function onSelectPhoto(file: File): void {
    // Temporary debug — remove after verifying. Logs only file metadata, no secrets.
    // eslint-disable-next-line no-console
    console.log('selected photo', file.name, file.type, file.size);
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  function updateVariant(idx: number, patch: Partial<VariantDraft>): void {
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => (i === idx ? { ...v, ...patch } : v)),
    }));
  }

  function removeVariant(idx: number): void {
    setDraft((d) => ({
      ...d,
      variants: d.variants.filter((_, i) => i !== idx),
    }));
  }

  function addVariant(): void {
    setDraft((d) => ({
      ...d,
      variants: [...d.variants, { size: '', color: '', stock: 0, priceOverride: '' }],
    }));
  }

  async function addCategory(): Promise<void> {
    const name = newCategoryName.trim();
    if (!name) return;
    try {
      const r = await api.post<{ category: CategoryOption }>('/api/categories', { name });
      setCategories((items) => [...items.filter((c) => c.id !== r.category.id), r.category]);
      setDraft((d) => ({ ...d, categoryId: r.category.id, category: r.category.name }));
      setNewCategoryName('');
      toast.success('Category added');
    } catch {
      toast.error('Category add failed. Only owner can manage categories.');
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!draft.category.trim()) {
      toast.error('Category is required');
      return;
    }
    if (draft.variants.length === 0 || draft.variants.some((v) => !v.size.trim())) {
      toast.error('Add at least one size with a size name');
      return;
    }
    if (!draft.basePrice || Number(draft.basePrice) <= 0) {
      toast.error('Price is required');
      return;
    }
    // Valid when a new photo is selected, or an existing image is already set (edit).
    if (!photoFile && !draft.imageUrl.trim()) {
      toast.error('Product photo is required');
      return;
    }
    setSaving(true);
    try {
      // Upload the selected photo now (multipart, field "photo"), then create/update the
      // product with the returned URL. Surfacing upload errors here avoids the misleading
      // "Product photo is required" when the real failure was the upload.
      let imageUrl = draft.imageUrl;
      let imagePublicId = draft.imagePublicId;
      if (photoFile) {
        const uploaded = await api.uploadProductImage(photoFile);
        imageUrl = uploaded.url;
        imagePublicId = uploaded.publicId ?? '';
      }
      // SKU has no input field anymore; auto-generate one for new products so the
      // backend's required unique sku is satisfied. Existing products keep theirs.
      await onSubmit({ ...draft, imageUrl, imagePublicId, sku: draft.sku.trim() || generateSku(draft) });
    } catch (err) {
      toast.error(`Save failed: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Name (optional)">
            <Input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Category">
              <select
                value={draft.categoryId || draft.category}
                onChange={(e) => {
                  const selected = categories.find((category) => category.id === e.target.value);
                  setDraft({
                    ...draft,
                    categoryId: selected?.id ?? '',
                    category: selected?.name ?? e.target.value,
                  });
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                required
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {!categories.some((c) => c.name === draft.category) && draft.category && (
                  <option value={draft.category}>{draft.category}</option>
                )}
              </select>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  placeholder="New category"
                />
                <Button type="button" variant="outline" onClick={addCategory}>
                  <Plus size={14} className="mr-2" /> Add
                </Button>
              </div>
            </Field>
            <Field label="Base price (₹)">
              <Input
                type="number"
                step="0.01"
                value={draft.basePrice}
                onChange={(e) => setDraft({ ...draft, basePrice: e.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="Product photo">
            <div className="flex items-center gap-4">
              {(photoPreview || draft.imageUrl) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={
                    photoPreview ??
                    (draft.imageUrl.startsWith('http')
                      ? draft.imageUrl
                      : `${BACKEND_BASE_URL}${draft.imageUrl}`)
                  }
                  alt="preview"
                  className="w-24 h-24 rounded object-cover border"
                />
              )}
              <Input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onSelectPhoto(file);
                }}
              />
            </div>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Stock by size</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.variants.map((v, i) => (
            <div
              key={`${v.id ?? 'new'}-${i}`}
              className="grid items-end gap-3 sm:grid-cols-[1fr_110px_140px_40px]"
            >
              <Field label="Size">
                <Input
                  value={v.size}
                  placeholder="38, XL, Free Size"
                  onChange={(e) => updateVariant(i, { size: e.target.value })}
                />
              </Field>
              <Field label="Stock">
                <Input
                  type="number"
                  min={0}
                  value={v.stock}
                  onChange={(e) => updateVariant(i, { stock: Number(e.target.value) })}
                />
              </Field>
              <Field label="Price override">
                <Input
                  type="number"
                  min={0}
                  step="0.01"
                  value={v.priceOverride}
                  onChange={(e) => updateVariant(i, { priceOverride: e.target.value })}
                />
              </Field>
              <Button type="button" variant="ghost" size="icon" onClick={() => removeVariant(i)} className="sm:self-end">
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" onClick={addVariant}>
            <Plus size={16} className="mr-2" /> Add Size
          </Button>
        </CardContent>
      </Card>

      <Button type="submit" disabled={saving}>
        {saving ? 'Saving…' : submitLabel}
      </Button>
    </form>
  );
}

function generateSku(draft: ProductDraft): string {
  const base =
    (draft.name || draft.category || 'product')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'product';
  return `${base}-${Date.now().toString(36)}`;
}

function dynamicSizeVariants(variants: VariantDraft[] | undefined): VariantDraft[] {
  if (variants && variants.length > 0) return variants;
  return DEFAULT_SIZES.map((size) => ({ size, color: '', stock: 0, priceOverride: '' }));
}

function fallbackCategories(): CategoryOption[] {
  return DEFAULT_CATEGORIES.map((name) => ({ id: name, name, isActive: true }));
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
