'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getDashboardSocket } from '@/lib/socket';
import { StatusBadge } from '@/components/status-badge';

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: string;
  createdAt: string;
  customer: { name: string | null; whatsappNumber: string };
  itemCount: number;
}

const STATUSES = [
  'ALL',
  'PENDING',
  'PAYMENT_RECEIVED',
  'PAYMENT_REVIEW',
  'VERIFIED',
  'PRINTED',
  'DISPATCHED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export default function OrdersPage(): React.ReactElement {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('ALL');
  const [orders, setOrders] = useState<Order[]>([]);
  const [pendingApproval, setPendingApproval] = useState(0);

  async function load(s: string): Promise<void> {
    const path = s === 'ALL' ? '/api/orders' : `/api/orders?status=${s}`;
    const r = await api.get<{ orders: Order[] }>(path);
    setOrders(r.orders);
  }

  async function loadPendingCount(): Promise<void> {
    const [review, received] = await Promise.all([
      api.get<{ orders: Order[] }>('/api/orders?status=PAYMENT_REVIEW'),
      api.get<{ orders: Order[] }>('/api/orders?status=PAYMENT_RECEIVED'),
    ]);
    setPendingApproval(review.orders.length + received.orders.length);
  }

  useEffect(() => {
    void load(status);
    void loadPendingCount();
  }, [status]);

  async function remove(id: string, label: string): Promise<void> {
    if (!confirm(`Delete order ${label}? Only PENDING / CANCELLED / REJECTED / EXPIRED orders can be deleted.`))
      return;
    try {
      await api.delete(`/api/orders/${id}?hard=true`);
      toast.success('Deleted');
      void load(status);
    } catch {
      toast.error('Delete failed — order may already be processed');
    }
  }

  useEffect(() => {
    const socket = getDashboardSocket();
    const reload = (): void => {
      void load(status);
      void loadPendingCount();
    };
    socket.on('order_created', reload);
    socket.on('order_status_changed', reload);
    socket.on('payment_received', reload);
    return () => {
      socket.off('order_created', reload);
      socket.off('order_status_changed', reload);
      socket.off('payment_received', reload);
    };
  }, [status]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Orders</h1>
        {pendingApproval > 0 && (
          <button
            type="button"
            onClick={() => setStatus('PAYMENT_REVIEW')}
            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-3 py-1 text-sm font-medium text-amber-900 ring-1 ring-amber-300 hover:bg-amber-200"
          >
            🔔 {pendingApproval} payment{pendingApproval === 1 ? '' : 's'} awaiting approval
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUSES.map((s) => (
          <Button
            key={s}
            variant={status === s ? 'default' : 'outline'}
            size="sm"
            onClick={() => setStatus(s)}
          >
            {s.replace('_', ' ')}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="p-0">
          {orders.length === 0 ? (
            <div className="p-6 text-sm text-muted-foreground">No orders in this status.</div>
          ) : (
            <Table className="min-w-[780px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-16 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => {
                  const deletable = ['PENDING', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(o.status);
                  return (
                    <TableRow key={o.id}>
                      <TableCell className="font-mono">
                        <Link href={`/orders/${o.id}`} className="hover:underline">
                          {o.orderNumber}
                        </Link>
                      </TableCell>
                      <TableCell>{o.customer.name ?? o.customer.whatsappNumber}</TableCell>
                      <TableCell>{o.itemCount}</TableCell>
                      <TableCell>{formatCurrency(o.totalAmount)}</TableCell>
                      <TableCell>
                        <StatusBadge status={o.status} />
                      </TableCell>
                      <TableCell>{formatDate(o.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        {deletable && (
                          <Button
                            size="icon"
                            variant="ghost"
                            onClick={() => void remove(o.id, o.orderNumber)}
                            title="Delete order"
                          >
                            <Trash2 size={14} className="text-destructive" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
