'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { CheckCircle2, XCircle, Printer, Truck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { api, ApiError, BACKEND_BASE_URL } from '@/lib/api';
import { formatCurrency, formatDate } from '@/lib/utils';
import { StatusBadge } from '@/components/status-badge';

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  approvalStatus: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  subtotal: string;
  shippingFee: string;
  totalAmount: string;
  shippingName: string;
  shippingAddress: string;
  shippingCity: string;
  shippingState: string;
  shippingPincode: string;
  paymentScreenshotUrl: string | null;
  paymentExtractedAmount: string | null;
  paymentExtractedUtr: string | null;
  paymentExtractedReceiver: string | null;
  paymentLooksLegitimate: boolean | null;
  paymentVerifiedAt: string | null;
  printedAt: string | null;
  createdAt: string;
  customer: { id: string; whatsappNumber: string; name: string | null };
  items: {
    id: string;
    quantity: number;
    unitPrice: string;
    variant: {
      size: string;
      color: string | null;
      product: { name: string; sku: string };
    };
  }[];
}

interface PrintResult {
  ok: boolean;
  mode: 'manual' | 'printnode';
  pdfUrl: string;
  printJobId: number | null;
  message: string;
}

export default function OrderDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    const r = await api.get<{ order: OrderDetail }>(`/api/orders/${params.id}`);
    setOrder(r.order);
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (!order) return <div className="text-sm text-muted-foreground">Loading…</div>;

  async function approveOrder(): Promise<void> {
    setBusy(true);
    try {
      await api.post(`/api/orders/${order!.id}/approve-order`);
      toast.success('Order approved — stock deducted');
      await reload();
    } catch {
      toast.error('Order approval failed. Check owner permission and stock.');
    } finally {
      setBusy(false);
    }
  }

  async function rejectOrder(): Promise<void> {
    const reason = window.prompt('Reason for rejecting this order (optional):') ?? '';
    setBusy(true);
    try {
      await api.post(`/api/orders/${order!.id}/reject-order`, { reason: reason || undefined });
      toast.success('Order rejected — customer notified');
      await reload();
    } catch {
      toast.error('Order rejection failed. Only owner can reject.');
    } finally {
      setBusy(false);
    }
  }

  async function updateDeliveryCharge(): Promise<void> {
    const value = window.prompt('Delivery charge for this order:', order!.shippingFee);
    if (value === null) return;
    const shippingFee = Number(value);
    if (!Number.isFinite(shippingFee) || shippingFee < 0) {
      toast.error('Enter a valid delivery charge');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/orders/${order!.id}/delivery-charge`, { shippingFee });
      toast.success('Delivery charge updated');
      await reload();
    } catch {
      toast.error('Could not update delivery charge. Only pending owner approval orders can be changed.');
    } finally {
      setBusy(false);
    }
  }

  async function approve(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.post<{ printJobId?: string | null }>(
        `/api/orders/${order!.id}/approve-payment`,
      );
      // The label is queued as a PrintJob; the Android bridge prints it without
      // any further click. Do not claim "Printed" until the bridge reports back.
      toast.success(
        result?.printJobId
          ? 'Payment approved. Print job queued.'
          : 'Payment approved — customer notified',
      );
      await reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error(paymentWarningMessage(err.body));
      } else {
        toast.error('Approval failed');
      }
    } finally {
      setBusy(false);
    }
  }

  async function reject(): Promise<void> {
    if (!confirm('Reject payment? Customer will be asked for another screenshot.')) return;
    setBusy(true);
    try {
      await api.post(`/api/orders/${order!.id}/reject-payment`, {});
      toast.success('Rejected — customer notified');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function dispatch(): Promise<void> {
    setBusy(true);
    try {
      await api.post(`/api/orders/${order!.id}/mark-dispatched`);
      toast.success('Marked dispatched');
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function cancelOrder(): Promise<void> {
    if (!confirm('Mark this order CANCELLED?')) return;
    setBusy(true);
    try {
      await api.delete(`/api/orders/${order!.id}`);
      toast.success('Cancelled');
      await reload();
    } catch {
      toast.error('Cancel failed — order may already be processed');
    } finally {
      setBusy(false);
    }
  }

  async function hardDelete(): Promise<void> {
    if (
      !confirm(
        'Permanently DELETE this order? This cannot be undone. Only PENDING / CANCELLED / REJECTED / EXPIRED orders can be deleted.',
      )
    )
      return;
    setBusy(true);
    try {
      await api.delete(`/api/orders/${order!.id}?hard=true`);
      toast.success('Order deleted');
      router.push('/orders');
    } catch {
      toast.error('Delete failed — order may already be processed');
    } finally {
      setBusy(false);
    }
  }

  async function reprint(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.post<PrintResult>(`/api/orders/${order!.id}/print`);
      showPrintResult(result);
      await reload();
    } catch {
      toast.error('Print failed');
    } finally {
      setBusy(false);
    }
  }

  async function printSticker(): Promise<void> {
    setBusy(true);
    try {
      const result = await api.post<PrintResult>(`/api/orders/${order!.id}/print-sticker`);
      showPrintResult(result);
      await reload();
    } catch {
      toast.error('Sticker print failed — check status/address');
    } finally {
      setBusy(false);
    }
  }

  const expected = Number(order.totalAmount);
  const got = order.paymentExtractedAmount ? Number(order.paymentExtractedAmount) : null;
  const amountMatch = got !== null && Math.abs(got - expected) < 0.5;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm text-muted-foreground">Order</div>
          <h1 className="text-2xl font-semibold font-mono">{order.orderNumber}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={order.status} />
          <Button variant="outline" onClick={() => router.push('/orders')}>
            Back
          </Button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Customer</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div className="font-medium">{order.shippingName}</div>
            <div>
              <a
                href={`https://wa.me/${order.customer.whatsappNumber}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary hover:underline"
              >
                {order.customer.whatsappNumber}
              </a>
            </div>
            <div className="text-muted-foreground">
              {order.shippingAddress}
              <br />
              {order.shippingCity}, {order.shippingState} — {order.shippingPincode}
            </div>
            <div className="text-xs text-muted-foreground pt-2">
              Created {formatDate(order.createdAt)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Totals</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <Row label="Subtotal" value={formatCurrency(order.subtotal)} />
            <Row label="Shipping" value={formatCurrency(order.shippingFee)} />
            <Row label="Owner approval" value={order.approvalStatus} />
            <div className="border-t pt-1 mt-1">
              <Row label="Total" value={formatCurrency(order.totalAmount)} bold />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Items</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Item</TableHead>
                <TableHead>Size / Color</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Unit</TableHead>
                <TableHead>Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {order.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">{i.variant.product.sku}</TableCell>
                  <TableCell>{i.variant.product.name}</TableCell>
                  <TableCell>
                    {i.variant.size}
                    {i.variant.color ? ` · ${i.variant.color}` : ''}
                  </TableCell>
                  <TableCell>{i.quantity}</TableCell>
                  <TableCell>{formatCurrency(i.unitPrice)}</TableCell>
                  <TableCell>{formatCurrency(Number(i.unitPrice) * i.quantity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {order.paymentScreenshotUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Payment</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`${BACKEND_BASE_URL}/api/uploads/${order.paymentScreenshotUrl}`}
              alt="payment screenshot"
              className="rounded border max-h-[400px] object-contain bg-muted"
            />
            <div className="space-y-2 text-sm">
              <Row
                label="Amount"
                value={`${formatCurrency(order.paymentExtractedAmount)} (expected ${formatCurrency(order.totalAmount)})`}
                bold
              />
              <div>
                <Badge variant={amountMatch ? 'success' : 'destructive'}>
                  {amountMatch ? 'Amount matches' : 'Amount mismatch'}
                </Badge>
              </div>
              <Row label="UTR" value={order.paymentExtractedUtr ?? '—'} />
              <Row label="Receiver" value={order.paymentExtractedReceiver ?? '—'} />
              <div>
                <Badge variant={order.paymentLooksLegitimate ? 'success' : 'warning'}>
                  {order.paymentLooksLegitimate ? 'Looks legitimate' : 'Looks suspicious'}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-wrap gap-2">
        {order.approvalStatus === 'PENDING_OWNER_APPROVAL' &&
          ['PENDING', 'PAYMENT_RECEIVED', 'PAYMENT_REVIEW'].includes(order.status) && (
            <>
              <Button variant="outline" onClick={updateDeliveryCharge} disabled={busy}>
                Edit Delivery
              </Button>
              <Button onClick={approveOrder} disabled={busy}>
                <CheckCircle2 size={16} className="mr-2" /> Approve Order
              </Button>
              <Button variant="destructive" onClick={rejectOrder} disabled={busy}>
                <XCircle size={16} className="mr-2" /> Reject Order
              </Button>
            </>
          )}
        {['PAYMENT_RECEIVED', 'PAYMENT_REVIEW'].includes(order.status) && (
          <>
            <Button onClick={approve} disabled={busy}>
              <CheckCircle2 size={16} className="mr-2" /> Approve &amp; Print
            </Button>
            <Button variant="destructive" onClick={reject} disabled={busy}>
              <XCircle size={16} className="mr-2" /> Reject
            </Button>
          </>
        )}
        {(order.status === 'VERIFIED' || order.status === 'PRINTED') && (
          <Button onClick={dispatch} disabled={busy}>
            <Truck size={16} className="mr-2" /> Mark dispatched
          </Button>
        )}
        {['VERIFIED', 'PRINTED'].includes(order.status) && (
          <Button variant="outline" onClick={reprint} disabled={busy}>
            <Printer size={16} className="mr-2" /> Print Bill
          </Button>
        )}
        {['VERIFIED', 'PRINTED'].includes(order.status) && (
          <Button variant="outline" onClick={printSticker} disabled={busy}>
            <Printer size={16} className="mr-2" /> Print Sticker
          </Button>
        )}
        {['PENDING', 'PAYMENT_RECEIVED', 'PAYMENT_REVIEW'].includes(order.status) && (
          <Button variant="outline" onClick={cancelOrder} disabled={busy}>
            <XCircle size={16} className="mr-2" /> Cancel order
          </Button>
        )}
        {['PENDING', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(order.status) && (
          <Button variant="destructive" onClick={hardDelete} disabled={busy}>
            <Trash2 size={16} className="mr-2" /> Delete permanently
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

function paymentWarningMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: string; warnings?: string[] };
    if (parsed.error === 'payment_review_required' && parsed.warnings?.length) {
      return `Payment needs review: ${parsed.warnings.join(', ')}`;
    }
  } catch {
    // Fall through to generic message.
  }
  return 'Approval blocked by order status or payment review';
}

function showPrintResult(result: PrintResult): void {
  if (result.pdfUrl) {
    window.open(`${BACKEND_BASE_URL}${result.pdfUrl}`, '_blank', 'noopener,noreferrer');
  }
  toast.success(result.message || (result.mode === 'printnode' ? 'Print job queued' : 'PDF generated'));
}
