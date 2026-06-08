'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { StatusBadge } from '@/components/status-badge';

interface Detail {
  id: string;
  name: string | null;
  email: string | null;
  whatsappNumber: string;
  defaultAddress: string | null;
  defaultCity: string | null;
  defaultState: string | null;
  defaultPincode: string | null;
  totalOrders: number;
  totalSpent: string;
  createdAt: string;
  orders: {
    id: string;
    orderNumber: string;
    status: string;
    totalAmount: string;
    createdAt: string;
  }[];
}

export default function CustomerDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [c, setC] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({
    name: '',
    email: '',
    defaultAddress: '',
    defaultCity: '',
    defaultState: '',
    defaultPincode: '',
  });

  async function load(): Promise<void> {
    const r = await api.get<{ customer: Detail }>(`/api/customers/${params.id}`);
    setC(r.customer);
    setDraft({
      name: r.customer.name ?? '',
      email: r.customer.email ?? '',
      defaultAddress: r.customer.defaultAddress ?? '',
      defaultCity: r.customer.defaultCity ?? '',
      defaultState: r.customer.defaultState ?? '',
      defaultPincode: r.customer.defaultPincode ?? '',
    });
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!c) return <div className="text-sm text-muted-foreground">Loading…</div>;

  async function save(): Promise<void> {
    setBusy(true);
    try {
      await api.put(`/api/customers/${c!.id}`, {
        name: draft.name || null,
        email: draft.email || null,
        defaultAddress: draft.defaultAddress || null,
        defaultCity: draft.defaultCity || null,
        defaultState: draft.defaultState || null,
        defaultPincode: draft.defaultPincode || null,
      });
      toast.success('Saved');
      await load();
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.body);
      else toast.error('Save failed');
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (
      !confirm(
        `Delete customer "${c!.name ?? c!.whatsappNumber}"? Conversations and messages will be removed. Orders block deletion.`,
      )
    )
      return;
    setBusy(true);
    try {
      await api.delete(`/api/customers/${c!.id}`);
      toast.success('Customer deleted');
      router.push('/customers');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error('Customer has orders — cannot delete. Cancel/delete those orders first.');
      } else {
        toast.error('Delete failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-2xl font-semibold">{c.name ?? c.whatsappNumber}</h1>
        <Button variant="destructive" onClick={remove} disabled={busy}>
          <Trash2 size={14} className="mr-2" /> Delete customer
        </Button>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Total orders</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{c.totalOrders}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Total spent</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold">{formatCurrency(c.totalSpent)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">
              Customer since
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">{formatDate(c.createdAt)}</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <Input
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              />
            </Field>
          </div>
          <Field label="WhatsApp">
            <Input value={c.whatsappNumber} disabled />
          </Field>
          <Field label="Default address">
            <Input
              value={draft.defaultAddress}
              onChange={(e) => setDraft({ ...draft, defaultAddress: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="City">
              <Input
                value={draft.defaultCity}
                onChange={(e) => setDraft({ ...draft, defaultCity: e.target.value })}
              />
            </Field>
            <Field label="State">
              <Input
                value={draft.defaultState}
                onChange={(e) => setDraft({ ...draft, defaultState: e.target.value })}
              />
            </Field>
            <Field label="Pincode">
              <Input
                value={draft.defaultPincode}
                onChange={(e) => setDraft({ ...draft, defaultPincode: e.target.value })}
              />
            </Field>
          </div>
          <Button onClick={save} disabled={busy}>
            <Save size={14} className="mr-2" /> Save profile
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Order history</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {c.orders.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No orders.</div>
          ) : (
            <Table className="min-w-[620px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c.orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
                    <TableCell>{formatCurrency(o.totalAmount)}</TableCell>
                    <TableCell>{formatDate(o.createdAt)}</TableCell>
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

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
