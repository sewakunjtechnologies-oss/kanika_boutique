'use client';

import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

interface Category {
  id: string;
  name: string;
  slug: string;
  isActive: boolean;
}

export default function CategoriesPage(): React.ReactElement {
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState('');

  async function load(): Promise<void> {
    const r = await api.get<{ categories: Category[] }>('/api/categories');
    setCategories(r.categories);
  }

  useEffect(() => {
    void load();
  }, []);

  async function addCategory(): Promise<void> {
    if (!name.trim()) return;
    try {
      await api.post('/api/categories', { name });
      setName('');
      toast.success('Category added');
      await load();
    } catch {
      toast.error('Only owner can add categories, or this category already exists.');
    }
  }

  async function toggle(category: Category): Promise<void> {
    try {
      await api.put(`/api/categories/${category.id}`, { isActive: !category.isActive });
      await load();
    } catch {
      toast.error('Only owner can update categories.');
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Categories</h1>
      <Card>
        <CardHeader>
          <CardTitle>Add category</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Category name" />
          <Button onClick={addCategory}>
            <Plus size={16} className="mr-2" /> Add
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table className="min-w-[560px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {categories.map((category) => (
                <TableRow key={category.id}>
                  <TableCell className="font-medium">{category.name}</TableCell>
                  <TableCell className="font-mono text-xs">{category.slug}</TableCell>
                  <TableCell>
                    <Badge variant={category.isActive ? 'success' : 'secondary'}>
                      {category.isActive ? 'Active' : 'Disabled'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="outline" size="sm" onClick={() => toggle(category)}>
                      {category.isActive ? 'Disable' : 'Enable'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
