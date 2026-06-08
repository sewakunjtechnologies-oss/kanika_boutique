'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { api, ApiError } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';

interface Customer {
  id: string;
  name: string | null;
  whatsappNumber: string;
  totalOrders: number;
  totalSpent: string;
  createdAt: string;
}

export default function CustomersPage(): React.ReactElement {
  const [customers, setCustomers] = useState<Customer[]>([]);

  async function load(): Promise<void> {
    const r = await api.get<{ customers: Customer[] }>('/api/customers');
    setCustomers(r.customers);
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(id: string, label: string): Promise<void> {
    if (!confirm(`Delete customer "${label}"? Orders block deletion.`)) return;
    try {
      await api.delete(`/api/customers/${id}`);
      toast.success('Deleted');
      void load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Customer has orders — cannot delete.');
      } else {
        toast.error('Delete failed');
      }
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Customers</h1>
      <Card>
        <CardContent className="p-0">
          {customers.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No customers yet.</div>
          ) : (
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>WhatsApp</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Spent</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="w-16 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customers.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/customers/${c.id}`} className="hover:underline">
                        {c.name ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{c.whatsappNumber}</TableCell>
                    <TableCell>{c.totalOrders}</TableCell>
                    <TableCell>{formatCurrency(c.totalSpent)}</TableCell>
                    <TableCell>{formatDate(c.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => void remove(c.id, c.name ?? c.whatsappNumber)}
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
