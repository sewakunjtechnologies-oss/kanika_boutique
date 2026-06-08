'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { StatusBadge } from '@/components/status-badge';
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';

interface Kpis {
  todayOrders: number;
  pendingVerification: number;
  monthRevenue: string;
  lowStockVariants: number;
}

interface Order {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: string;
  createdAt: string;
  customer: { name: string | null; whatsappNumber: string };
}

export default function HomePage(): React.ReactElement {
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);

  useEffect(() => {
    void api.get<Kpis>('/api/orders-summary/kpis').then(setKpis).catch(() => undefined);
    void api
      .get<{ orders: Order[] }>('/api/orders?limit=10')
      .then((r) => setOrders(r.orders))
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Today's orders" value={kpis?.todayOrders ?? '—'} />
        <KpiCard label="Pending verification" value={kpis?.pendingVerification ?? '—'} />
        <KpiCard label="This month" value={formatCurrency(kpis?.monthRevenue ?? null)} />
        <KpiCard label="Low stock variants" value={kpis?.lowStockVariants ?? '—'} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent orders</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {orders.length === 0 ? (
            <p className="text-sm text-muted-foreground">No orders yet. They appear here when customers complete a WhatsApp checkout.</p>
          ) : (
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Order #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Total</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {orders.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-mono">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.orderNumber}
                      </Link>
                    </TableCell>
                    <TableCell>{o.customer.name ?? o.customer.whatsappNumber}</TableCell>
                    <TableCell>{formatCurrency(o.totalAmount)}</TableCell>
                    <TableCell>
                      <StatusBadge status={o.status} />
                    </TableCell>
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

function KpiCard({ label, value }: { label: string; value: string | number }): React.ReactElement {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm text-muted-foreground font-normal">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
