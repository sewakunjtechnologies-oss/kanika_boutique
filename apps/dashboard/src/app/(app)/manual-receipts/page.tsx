'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ImageIcon, Plus, Printer } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  filterReceiptProducts,
  findDefaultVariant,
  isSelectableReceiptProduct,
  productAvailableSizes,
  productDisplayName,
  productTotalStock,
  type ManualReceiptProduct,
} from '@/lib/manual-receipt-products';
import { formatCurrency, formatDate } from '@/lib/utils';

type Product = ManualReceiptProduct;

interface ReceiptSummary {
  id: string;
  receiptNumber: string;
  customerName: string | null;
  customerPhone: string | null;
  totalAmount: string;
  paymentMode: string;
  createdAt: string;
  itemCount: number;
}

interface DraftItem {
  productId: string;
  productVariantId: string;
  quantity: number;
  unitPrice: string;
}

interface PrintResult {
  ok: boolean;
  printJobId: string;
  status: string;
  created: boolean;
  message: string;
}

export default function ManualReceiptsPage(): React.ReactElement {
  const [products, setProducts] = useState<Product[]>([]);
  const [receipts, setReceipts] = useState<ReceiptSummary[]>([]);
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [items, setItems] = useState<DraftItem[]>([{ productId: '', productVariantId: '', quantity: 1, unitPrice: '' }]);
  const [deliveryOverride, setDeliveryOverride] = useState('');
  const [discount, setDiscount] = useState('0');
  const [paymentMode, setPaymentMode] = useState('CASH');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [printingId, setPrintingId] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');

  async function load(): Promise<void> {
    const [productRes, receiptRes] = await Promise.all([
      api.get<{ products: Product[] }>('/api/products?limit=200'),
      api.get<{ receipts: ReceiptSummary[] }>('/api/manual-receipts'),
    ]);
    setProducts(productRes.products);
    setReceipts(receiptRes.receipts);
  }

  useEffect(() => {
    void load();
  }, []);

  const totalQty = items.reduce((sum, item) => sum + Math.max(item.quantity, 0), 0);
  const subtotal = items.reduce((sum, item) => sum + Number(item.unitPrice || 0) * Math.max(item.quantity, 0), 0);
  const deliveryCharge = deliveryOverride ? Number(deliveryOverride) : calculateDeliveryCharge(totalQty);
  const total = Math.max(subtotal + deliveryCharge - Number(discount || 0), 0);

  const productById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const visibleProducts = useMemo(
    () => filterReceiptProducts(products, productSearch).slice(0, 30),
    [products, productSearch],
  );

  function updateItem(index: number, patch: Partial<DraftItem>): void {
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function selectProduct(index: number, productId: string): void {
    const product = productById.get(productId);
    if (!product || !isSelectableReceiptProduct(product)) return;
    const variant = findDefaultVariant(product);
    updateItem(index, {
      productId,
      productVariantId: variant?.id ?? '',
      unitPrice: variant ? (variant.priceOverride ?? product.basePrice) : '',
    });
  }

  function selectVariant(index: number, variantId: string): void {
    const item = items[index];
    if (!item) return;
    const product = productById.get(item.productId);
    const variant = product?.variants.find((v) => v.id === variantId);
    updateItem(index, {
      productVariantId: variantId,
      unitPrice: variant && product ? (variant.priceOverride ?? product.basePrice) : item.unitPrice,
    });
  }

  async function save(): Promise<void> {
    const payloadItems = items
      .filter((item) => item.productVariantId && item.quantity > 0)
      .map((item) => ({
        productVariantId: item.productVariantId,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
      }));
    if (payloadItems.length === 0) {
      toast.error('Add at least one product');
      return;
    }
    setSaving(true);
    try {
      await api.post('/api/manual-receipts', {
        customerName: customerName || null,
        customerPhone: customerPhone || null,
        items: payloadItems,
        deliveryCharge: deliveryOverride ? Number(deliveryOverride) : null,
        discount: Number(discount || 0),
        paymentMode,
        notes: notes || null,
      });
      toast.success('Manual receipt saved');
      setItems([{ productId: '', productVariantId: '', quantity: 1, unitPrice: '' }]);
      setCustomerName('');
      setCustomerPhone('');
      setDeliveryOverride('');
      setDiscount('0');
      setNotes('');
      await load();
    } catch {
      toast.error('Could not save receipt. Check stock and permissions.');
    } finally {
      setSaving(false);
    }
  }

  async function printReceipt(id: string): Promise<void> {
    if (printingId) return;
    setPrintingId(id);
    try {
      const result = await api.post<PrintResult>(`/api/manual-receipts/${id}/print`);
      showPrintResult(result);
    } catch (err) {
      toast.error(apiErrorMessage(err, 'Print failed'));
    } finally {
      setPrintingId(null);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Manual Receipt</h1>

      <Card>
        <CardHeader>
          <CardTitle>Create offline sale</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Customer name">
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </Field>
            <Field label="Customer phone">
              <Input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
            </Field>
          </div>

          <div className="space-y-3">
            {items.map((item, index) => {
              const product = productById.get(item.productId);
              const selectedVariant = product?.variants.find((variant) => variant.id === item.productVariantId);
              return (
                <div key={index} className="space-y-3 rounded-md border border-border p-3">
                  <Field label="Product">
                    <Input
                      value={productSearch}
                      onChange={(e) => setProductSearch(e.target.value)}
                      placeholder="Search by name, SKU, article, category, or size"
                    />
                    <div className="grid max-h-[360px] gap-2 overflow-y-auto pt-2 sm:grid-cols-2 xl:grid-cols-3">
                      {visibleProducts.map((p) => {
                        const selectable = isSelectableReceiptProduct(p);
                        const selected = p.id === item.productId;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            disabled={!selectable}
                            onClick={() => selectProduct(index, p.id)}
                            className={`grid min-h-[112px] grid-cols-[72px_1fr] gap-3 rounded-md border p-2 text-left transition ${
                              selected
                                ? 'border-primary bg-primary/5'
                                : 'border-border hover:border-primary/50'
                            } ${selectable ? '' : 'cursor-not-allowed opacity-55'}`}
                          >
                            <ProductThumb product={p} className="h-[88px] w-[72px]" />
                            <span className="min-w-0 space-y-1 text-xs">
                              <span className="block truncate text-sm font-medium">{productDisplayName(p)}</span>
                              <span className="block truncate font-mono">SKU: {p.sku}</span>
                              <span className="block truncate">{p.category || 'Uncategorised'}</span>
                              <span className="block truncate">Sizes: {productAvailableSizes(p).join(', ') || '-'}</span>
                              <span className="block">
                                Stock: {productTotalStock(p)} · {formatCurrency(p.basePrice)}
                              </span>
                              {!selectable && <span className="block font-medium text-destructive">Out of stock</span>}
                            </span>
                          </button>
                        );
                      })}
                      {visibleProducts.length === 0 && (
                        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                          No active products match this search.
                        </div>
                      )}
                    </div>
                  </Field>
                  {product && (
                    <div className="grid gap-3 rounded-md bg-muted/35 p-3 sm:grid-cols-[104px_1fr]">
                      <ProductThumb product={product} className="h-[128px] w-[104px]" />
                      <div className="min-w-0 text-sm">
                        <div className="truncate font-medium">{productDisplayName(product)}</div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">SKU: {product.sku}</div>
                        <div className="mt-1 text-muted-foreground">{product.category || 'Uncategorised'}</div>
                        <div className="mt-2">
                          Sizes: {productAvailableSizes(product).join(', ') || '-'} · Stock: {productTotalStock(product)}
                        </div>
                        {selectedVariant && (
                          <div className="mt-1">
                            Selected size {selectedVariant.size}: {selectedVariant.stock} in stock
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_90px_110px]">
                  <Field label="Size">
                    <select
                      value={item.productVariantId}
                      onChange={(e) => selectVariant(index, e.target.value)}
                      className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="">Select size</option>
                      {product?.variants.map((variant) => (
                        <option key={variant.id} value={variant.id}>
                          {variant.size} ({variant.stock})
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Qty">
                    <Input
                      type="number"
                      min={1}
                      value={item.quantity}
                      onChange={(e) => updateItem(index, { quantity: Number(e.target.value) })}
                    />
                  </Field>
                  <Field label="Price">
                    <Input
                      type="number"
                      min={0}
                      value={item.unitPrice}
                      onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
                    />
                  </Field>
                  </div>
                </div>
              );
            })}
            <Button
              variant="outline"
              onClick={() => setItems((current) => [...current, { productId: '', productVariantId: '', quantity: 1, unitPrice: '' }])}
            >
              <Plus size={16} className="mr-2" /> Add item
            </Button>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Delivery override">
              <Input value={deliveryOverride} onChange={(e) => setDeliveryOverride(e.target.value)} placeholder={`${deliveryCharge}`} />
            </Field>
            <Field label="Discount">
              <Input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} />
            </Field>
            <Field label="Payment">
              <select
                value={paymentMode}
                onChange={(e) => setPaymentMode(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="PAY_LATER">Pay later</option>
              </select>
            </Field>
            <Field label="Total">
              <Input value={formatCurrency(total)} readOnly />
            </Field>
          </div>

          <Field label="Notes">
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>

          <Button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save receipt'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent receipts</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>Receipt</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Total</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Print</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.map((receipt) => (
                <TableRow key={receipt.id}>
                  <TableCell>
                    <Link href={`/manual-receipts/${receipt.id}`} className="font-mono text-primary hover:underline">
                      {receipt.receiptNumber}
                    </Link>
                  </TableCell>
                  <TableCell>{receipt.customerName || receipt.customerPhone || 'Walk-in'}</TableCell>
                  <TableCell>{receipt.itemCount}</TableCell>
                  <TableCell>{formatCurrency(receipt.totalAmount)}</TableCell>
                  <TableCell>{receipt.paymentMode}</TableCell>
                  <TableCell>{formatDate(receipt.createdAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => printReceipt(receipt.id)}
                      disabled={printingId === receipt.id}
                    >
                      <Printer size={14} className="mr-2" /> {printingId === receipt.id ? 'Queuing…' : 'Print'}
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

function calculateDeliveryCharge(quantity: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return 100 + (Math.floor(quantity) - 1) * 50;
}

function ProductThumb({ product, className }: { product: Product; className: string }): React.ReactElement {
  if (!product.imageUrl) {
    return (
      <span className={`${className} flex items-center justify-center rounded-md bg-muted text-muted-foreground`}>
        <ImageIcon size={22} />
      </span>
    );
  }
  return (
    <img
      src={product.imageUrl}
      alt={productDisplayName(product)}
      className={`${className} rounded-md object-cover`}
      loading="lazy"
    />
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
