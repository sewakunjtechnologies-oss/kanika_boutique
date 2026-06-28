'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Plus, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { api, BACKEND_BASE_URL } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';

interface Product {
  id: string;
  sku: string;
  name: string;
  category: string;
  basePrice: string;
  imageUrl: string;
  isActive: boolean;
  totalStock: number;
}

export default function InventoryPage(): React.ReactElement {
  const [q, setQ] = useState('');
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load(nextStatus: 'active' | 'archived' = status): Promise<void> {
    setLoading(true);
    try {
      const r = await api.get<{ products: Product[] }>(
        `/api/products?q=${encodeURIComponent(q)}&status=${nextStatus}`,
      );
      setProducts(r.products);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <Button asChild>
          <Link href="/inventory/new">
            <Plus size={16} className="mr-2" /> Add product
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1 sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
            placeholder="Search by name, SKU, category…"
            className="pl-9"
          />
        </div>
        <Button variant="outline" onClick={() => load()}>
          Search
        </Button>
        <Button
          variant={status === 'archived' ? 'default' : 'outline'}
          onClick={() => {
            const next = status === 'active' ? 'archived' : 'active';
            setStatus(next);
            void load(next);
          }}
        >
          {status === 'archived' ? 'Viewing archived' : 'Show archived'}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 text-sm text-muted-foreground">Loading…</div>
          ) : products.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No products yet. Add your first one above.</div>
          ) : (
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16"></TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Stock</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-16 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((p) => (
                  <TableRow key={p.id} className="cursor-pointer">
                    <TableCell>
                      <Link href={`/inventory/${p.id}`}>
                        {p.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={p.imageUrl.startsWith('http') ? p.imageUrl : `${BACKEND_BASE_URL}${p.imageUrl}`}
                            alt={p.name}
                            className="w-12 h-12 rounded object-cover"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded bg-muted" />
                        )}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Link href={`/inventory/${p.id}`} className="hover:underline">
                        {p.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{p.sku}</TableCell>
                    <TableCell>{p.category}</TableCell>
                    <TableCell>{formatCurrency(p.basePrice)}</TableCell>
                    <TableCell>{p.totalStock}</TableCell>
                    <TableCell>
                      <Badge variant={p.isActive ? 'success' : 'secondary'}>
                        {p.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {!p.isActive && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="mr-2"
                          disabled={deletingId === p.id}
                          onClick={async (e) => {
                            e.stopPropagation();
                            setDeletingId(p.id);
                            try {
                              await api.put(`/api/products/${p.id}`, { isActive: true });
                              toast.success('Product restored');
                              await load();
                            } catch {
                              toast.error('Restore failed');
                            } finally {
                              setDeletingId(null);
                            }
                          }}
                        >
                          Restore
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        disabled={deletingId === p.id}
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (deletingId) return; // prevent double-click / concurrent deletes
                          if (
                            !confirm(
                              `Delete "${p.name}"?\n\nIf it is used in existing orders or receipts it will be archived (kept for history) instead of permanently deleted.`,
                            )
                          )
                            return;
                          setDeletingId(p.id);
                          try {
                            const r = await api.delete<{ action?: 'deleted' | 'archived'; mode?: string; reason?: string }>(
                              `/api/products/${p.id}?hard=true`,
                            );
                            if (r.action === 'deleted' || r.mode === 'hard') toast.success('Product deleted');
                            else toast.success(r.reason ?? 'Product archived (kept for order history)');
                            await load();
                          } catch {
                            toast.error('Delete failed — product was not changed');
                          } finally {
                            setDeletingId(null);
                          }
                        }}
                      >
                        <Trash2 size={14} className="text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
