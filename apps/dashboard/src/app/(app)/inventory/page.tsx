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

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api.get<{ products: Product[] }>(`/api/products?q=${encodeURIComponent(q)}`);
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
        <Button variant="outline" onClick={load}>
          Search
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
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm(`Delete "${p.name}"? Cannot be undone if no orders reference it.`))
                            return;
                          try {
                            const r = await api.delete<{ mode: 'hard' | 'soft_fallback'; reason?: string }>(
                              `/api/products/${p.id}?hard=true`,
                            );
                            if (r.mode === 'hard') toast.success('Deleted');
                            else toast.warning(r.reason ?? 'Deactivated (had order history)');
                            void load();
                          } catch {
                            toast.error('Delete failed');
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
