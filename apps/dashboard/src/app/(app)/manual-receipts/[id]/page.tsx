'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { History, Printer, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  status: 'ACTIVE' | 'PARTIALLY_RETURNED' | 'RETURNED' | 'VOIDED';
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
  items: ReceiptItem[];
  returns: ReceiptReturn[];
}

interface ReceiptItem {
  id: string;
  quantity: number;
  returnedQuantity: number;
  unitPrice: string;
  variant: {
    size: string;
    color: string | null;
    product: { sku: string; name: string };
  };
}

interface ReceiptReturn {
  id: string;
  status: string;
  reason: string;
  refundMethod: string;
  refundAmount: string;
  notes: string | null;
  createdAt: string;
  createdBy: { name: string; email: string };
  items: {
    id: string;
    quantity: number;
    unitAmount: string;
    refundAmount: string;
    receiptItem: {
      variant: { product: { sku: string; name: string }; size: string };
    };
  }[];
}

interface PrintJobSummary {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  printedAt: string | null;
  lastError: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  reprint: boolean;
  reprintNumber: number | null;
}

interface PrintResult {
  ok: boolean;
  printJobId: string;
  status: string;
  created: boolean;
  message: string;
  reprintNumber?: number;
}

interface ReturnResult {
  ok: boolean;
  returnId: string;
  created: boolean;
  refundAmount: string;
  status: string;
}

export default function ManualReceiptDetailPage(): React.ReactElement {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);
  const [printJobs, setPrintJobs] = useState<PrintJobSummary[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [showPrintHistory, setShowPrintHistory] = useState(false);
  const [showReturnHistory, setShowReturnHistory] = useState(false);
  const [showReturnForm, setShowReturnForm] = useState(false);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnReason, setReturnReason] = useState('');
  const [refundMethod, setRefundMethod] = useState('CASH');
  const [returnNotes, setReturnNotes] = useState('');

  async function load(): Promise<void> {
    const [receiptRes, printRes] = await Promise.all([
      api.get<{ receipt: ReceiptDetail }>(`/api/manual-receipts/${params.id}`),
      api.get<{ jobs: PrintJobSummary[] }>(`/api/manual-receipts/${params.id}/print-jobs`),
    ]);
    setReceipt(receiptRes.receipt);
    setPrintJobs(printRes.jobs);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  const initialPrint = printJobs.find((job) => !job.reprint);
  const reprintCount = printJobs.filter((job) => job.reprint).length;
  const lastPrintedAt = printJobs
    .map((job) => job.printedAt)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

  const returnableItems = useMemo(
    () => receipt?.items.map((item) => ({ item, remaining: item.quantity - item.returnedQuantity })).filter((entry) => entry.remaining > 0) ?? [],
    [receipt],
  );

  const refundPreview = useMemo(() => {
    if (!receipt || refundMethod === 'NO_REFUND') return 0;
    const totalGross = receipt.items.reduce((sum, item) => sum + Number(item.unitPrice) * item.quantity, 0);
    const discount = Number(receipt.discount || 0);
    return receipt.items.reduce((sum, item) => {
      const quantity = Math.min(returnQuantities[item.id] ?? 0, item.quantity - item.returnedQuantity);
      if (quantity <= 0) return sum;
      const gross = Number(item.unitPrice) * quantity;
      const discountShare = totalGross > 0 ? (discount * gross) / totalGross : 0;
      return sum + Math.max(gross - discountShare, 0);
    }, 0);
  }, [receipt, refundMethod, returnQuantities]);

  async function printInitial(): Promise<void> {
    if (!receipt) return;
    await runBusy('print', async () => {
      const result = await api.post<PrintResult>(`/api/manual-receipts/${receipt.id}/print`);
      showPrintResult(result);
      await load();
    });
  }

  async function reprintReceipt(): Promise<void> {
    if (!receipt) return;
    await runBusy('reprint', async () => {
      const result = await api.post<PrintResult>(`/api/manual-receipts/${receipt.id}/reprint`, {
        requestId: createRequestId(),
      });
      showPrintResult(result);
      await load();
    });
  }

  async function submitReturn(): Promise<void> {
    if (!receipt) return;
    const items = Object.entries(returnQuantities)
      .map(([receiptItemId, quantity]) => ({ receiptItemId, quantity: Number(quantity) }))
      .filter((item) => item.quantity > 0);
    if (!returnReason.trim()) {
      toast.error('Enter a return reason');
      return;
    }
    if (items.length === 0) {
      toast.error('Enter at least one return quantity');
      return;
    }
    await runBusy('return', async () => {
      const result = await api.post<ReturnResult>(`/api/manual-receipts/${receipt.id}/return`, {
        reason: returnReason,
        refundMethod,
        notes: returnNotes || null,
        requestId: createRequestId(),
        items,
      });
      toast.success(`Return saved. Refund ${formatCurrency(result.refundAmount)}`);
      setReturnQuantities({});
      setReturnReason('');
      setReturnNotes('');
      setShowReturnForm(false);
      setShowReturnHistory(true);
      await load();
    });
  }

  async function printReturnSlip(returnId: string, reprint: boolean): Promise<void> {
    if (!receipt) return;
    await runBusy(`${reprint ? 'return-reprint' : 'return-print'}-${returnId}`, async () => {
      const path = `/api/manual-receipts/${receipt.id}/returns/${returnId}/${reprint ? 'reprint' : 'print'}`;
      const result = await api.post<PrintResult>(path, { requestId: createRequestId() });
      showPrintResult(result);
    });
  }

  async function runBusy(action: string, fn: () => Promise<void>): Promise<void> {
    setBusyAction(action);
    try {
      await fn();
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Action failed'));
    } finally {
      setBusyAction(null);
    }
  }

  if (!receipt) return <div className="text-sm text-muted-foreground">Loading...</div>;

  const cannotReturn = receipt.status === 'RETURNED' || receipt.status === 'VOIDED' || returnableItems.length === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm text-muted-foreground">Manual receipt</div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-2xl font-semibold">{receipt.receiptNumber}</h1>
            <StatusBadge status={receipt.status} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => router.push('/manual-receipts')}>
            Back
          </Button>
          {!initialPrint ? (
            <Button onClick={printInitial} disabled={Boolean(busyAction)}>
              <Printer size={16} className="mr-2" /> {busyAction === 'print' ? 'Queuing...' : 'Print Receipt'}
            </Button>
          ) : (
            <Button onClick={reprintReceipt} disabled={Boolean(busyAction)}>
              <Printer size={16} className="mr-2" /> {busyAction === 'reprint' ? 'Queuing...' : 'Reprint Receipt'}
            </Button>
          )}
          <Button variant="outline" onClick={() => setShowReturnForm((value) => !value)} disabled={cannotReturn || Boolean(busyAction)}>
            <RotateCcw size={16} className="mr-2" /> Return Receipt
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
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
            <div className="mt-1 border-t pt-1">
              <Row label="Total" value={formatCurrency(receipt.totalAmount)} bold />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Print status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Initial" value={initialPrint ? initialPrint.status : 'Not queued'} />
            <Row label="Initial printed" value={initialPrint?.printedAt ? formatDate(initialPrint.printedAt) : '-'} />
            <Row label="Reprints" value={String(reprintCount)} />
            <Row label="Last printed" value={lastPrintedAt ? formatDate(lastPrintedAt) : '-'} />
            <Button variant="outline" size="sm" onClick={() => setShowPrintHistory((value) => !value)}>
              <History size={14} className="mr-2" /> View Print History
            </Button>
          </CardContent>
        </Card>
      </div>

      {showReturnForm && (
        <Card>
          <CardHeader>
            <CardTitle>Return receipt</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <Table className="min-w-[760px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>Sold</TableHead>
                    <TableHead>Returned</TableHead>
                    <TableHead>Remaining</TableHead>
                    <TableHead>Return Qty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {returnableItems.map(({ item, remaining }) => (
                    <TableRow key={item.id}>
                      <TableCell>
                        <div>{item.variant.product.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{item.variant.product.sku} / {item.variant.size}</div>
                      </TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell>{item.returnedQuantity}</TableCell>
                      <TableCell>{remaining}</TableCell>
                      <TableCell>
                        <Input
                          className="w-24"
                          type="number"
                          min={0}
                          max={remaining}
                          value={returnQuantities[item.id] ?? 0}
                          onChange={(e) => {
                            const next = Math.min(Math.max(Number(e.target.value || 0), 0), remaining);
                            setReturnQuantities((current) => ({ ...current, [item.id]: next }));
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <Field label="Reason">
                <Input value={returnReason} onChange={(e) => setReturnReason(e.target.value)} placeholder="Customer returned item" />
              </Field>
              <Field label="Refund method">
                <select
                  value={refundMethod}
                  onChange={(e) => setRefundMethod(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="CASH">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="STORE_CREDIT">Store credit</option>
                  <option value="NO_REFUND">No refund</option>
                </select>
              </Field>
              <Field label="Refund preview">
                <Input value={formatCurrency(refundPreview)} readOnly />
              </Field>
            </div>
            <Field label="Notes">
              <Input value={returnNotes} onChange={(e) => setReturnNotes(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button onClick={submitReturn} disabled={busyAction === 'return'}>
                {busyAction === 'return' ? 'Saving...' : 'Confirm Return'}
              </Button>
              <Button variant="outline" onClick={() => setShowReturnForm(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Items</CardTitle>
          <Button variant="outline" size="sm" onClick={() => setShowReturnHistory((value) => !value)}>
            <History size={14} className="mr-2" /> View Return History
          </Button>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>SKU</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Qty</TableHead>
                <TableHead>Returned</TableHead>
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
                  <TableCell>{item.returnedQuantity}</TableCell>
                  <TableCell>{formatCurrency(item.unitPrice)}</TableCell>
                  <TableCell>{formatCurrency(Number(item.unitPrice) * item.quantity)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {showPrintHistory && (
        <Card>
          <CardHeader>
            <CardTitle>Print history</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Queued</TableHead>
                  <TableHead>Printed</TableHead>
                  <TableHead>Requested by</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {printJobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>{job.reprint ? `Reprint #${job.reprintNumber ?? '-'}` : 'Initial'}</TableCell>
                    <TableCell>{job.status}</TableCell>
                    <TableCell>{formatDate(job.createdAt)}</TableCell>
                    <TableCell>{job.printedAt ? formatDate(job.printedAt) : '-'}</TableCell>
                    <TableCell>{job.requestedBy || '-'}</TableCell>
                    <TableCell>{job.lastError || '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {showReturnHistory && (
        <Card>
          <CardHeader>
            <CardTitle>Return history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {receipt.returns.length === 0 ? (
              <div className="text-sm text-muted-foreground">No returns yet.</div>
            ) : receipt.returns.map((returnRecord) => (
              <div key={returnRecord.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-mono font-medium">{returnRecord.id}</div>
                    <div className="text-muted-foreground">{formatDate(returnRecord.createdAt)} / {returnRecord.refundMethod}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="secondary">{returnRecord.status}</Badge>
                    <Button variant="outline" size="sm" onClick={() => printReturnSlip(returnRecord.id, false)} disabled={Boolean(busyAction)}>
                      Print Return Slip
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => printReturnSlip(returnRecord.id, true)} disabled={Boolean(busyAction)}>
                      Reprint Slip
                    </Button>
                  </div>
                </div>
                <div className="mt-2">Refund: {formatCurrency(returnRecord.refundAmount)}</div>
                <div>Reason: {returnRecord.reason}</div>
                <div className="mt-2 text-muted-foreground">
                  {returnRecord.items.map((item) => `${item.receiptItem.variant.product.name} x ${item.quantity}`).join(', ')}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

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

function StatusBadge({ status }: { status: ReceiptDetail['status'] }): React.ReactElement {
  const variant = status === 'RETURNED' || status === 'VOIDED' ? 'destructive' : status === 'PARTIALLY_RETURNED' ? 'warning' : 'success';
  return <Badge variant={variant}>{status.replace('_', ' ')}</Badge>;
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold' : ''}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function showPrintResult(result: PrintResult): void {
  toast.success(`${result.message || 'Print job created'}: ${result.status}`);
}

function createRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
