'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api, apiErrorMessage } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';

interface ReceiptDetail {
  id: string;
  receiptNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  subtotal: string;
  deliveryCharge: string;
  discount: string;
  totalAmount: string;
  paymentMode: string;
  notes: string | null;
  printedAt: string | null;
  createdAt: string;
  createdBy: { name: string; email: string };
  items: {
    id: string;
    quantity: number;
    unitPrice: string;
    variant: {
      size: string;
      color: string | null;
      product: { sku: string; name: string };
    };
  }[];
}

interface PrintResult {
  ok: boolean;
  printJobId: string;
  status: string;
  created: boolean;
  message: string;
}

export default function ManualReceiptDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    const r = await api.get<{ receipt: ReceiptDetail }>(`/api/manual-receipts/${params.id}`);
    setReceipt(r.receipt);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  async function print(): Promise<void> {
    if (!receipt) return;
    setBusy(true);
    try {
      const result = await api.post<PrintResult>(`/api/manual-receipts/${receipt.id}/print`);
      showPrintResult(result);
      await load();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Print failed'));
    } finally {
      setBusy(false);
    }
  }

  if (!receipt) return <div className="text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm text-muted-foreground">Manual receipt</div>
          <h1 className="text-2xl font-semibold font-mono">{receipt.receiptNumber}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => router.push('/manual-receipts')}>
            Back
          </Button>
          <Button onClick={print} disabled={busy}>
            <Printer size={16} className="mr-2" /> {busy ? 'Queuing…' : 'Print Receipt'}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="font-medium">{receipt.customerName || 'Walk-in customer'}</div>
            <div className="text-muted-foreground">{receipt.customerPhone || 'No phone'}</div>
            <div className="text-xs text-muted-foreground">Created {formatDate(receipt.createdAt)}</div>
            <div className="text-xs text-muted-foreground">By {receipt.createdBy.name || receipt.createdBy.email}</div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Subtotal" value={formatCurrency(receipt.subtotal)} />
            <Row label="Delivery" value={formatCurrency(receipt.deliveryCharge)} />
            <Row label="Discount" value={formatCurrency(receipt.discount)} />
            <Row label="Payment" value={receipt.paymentMode} />
            <div className="border-t pt-1 mt-1">
              <Row label="Total" value={formatCurrency(receipt.totalAmount)} bold />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="min-w-[680px]">
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipt.items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="font-mono text-xs">{item.variant.product.sku}</TableCell>
                  <TableCell>{item.variant.product.name}</TableCell>
                  <TableCell>{item.variant.size}</TableCell>
                  <TableCell>{item.quantity}</TableCell>
                  <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                  <TableCell>{formatCurrency(Number(item.unitPrice) * item.quantity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {receipt.notes && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{receipt.notes}</CardContent>
        </Card>
      )}
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

function showPrintResult(result: PrintResult): void {
  toast.success(`${result.message || 'Print job created'}: ${result.status}`);
}
