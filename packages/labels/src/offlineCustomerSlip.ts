import { z } from 'zod';
import { DEFAULT_LABEL_SIZE } from './profiles';
import type { LabelSizeInput } from './profiles';
import { escapeHtml, renderCode128BarcodeSvg, testedLabelCss } from './renderer';

const SlipItemSchema = z.object({
  name: z.string().default('Item'),
  sku: z.string().default(''),
  size: z.string().default(''),
  quantity: z.number().int().positive(),
  unitPrice: z.number().nonnegative(),
  amount: z.number().nonnegative(),
});

export const OfflineCustomerSlipPayloadSchema = z.object({
  templateVersion: z.literal('manual-receipt-v1'),
  storeName: z.string().min(1),
  receiptId: z.string().min(1),
  customerName: z.string().default('Walk-in customer'),
  phoneMasked: z.string().default(''),
  createdAt: z.string().min(1),
  paymentMethod: z.string().min(1),
  subtotal: z.number().nonnegative(),
  delivery: z.number().nonnegative(),
  discount: z.number().nonnegative(),
  total: z.number().nonnegative(),
  items: z.array(SlipItemSchema).min(1),
  barcodeValue: z.string().min(1),
});

export type OfflineCustomerSlipPayload = z.infer<typeof OfflineCustomerSlipPayloadSchema>;

export function parseOfflineCustomerSlipPayload(value: unknown): OfflineCustomerSlipPayload {
  return OfflineCustomerSlipPayloadSchema.parse(value);
}

export async function renderManualReceiptHtml(
  rawPayload: OfflineCustomerSlipPayload,
  size: LabelSizeInput = DEFAULT_LABEL_SIZE,
): Promise<string> {
  const payload = parseOfflineCustomerSlipPayload(rawPayload);
  const item = summarizeItems(payload.items);
  const barcodeSvg = await renderCode128BarcodeSvg(payload.barcodeValue);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
${testedLabelCss(size)}
  </style>
</head>
<body>
  <main class="label">
    <header class="header">
      <div class="brand">KANIKA DESIGNS</div>
      <div class="paid">RECEIPT</div>
    </header>

    <div class="order-id">
      Receipt ID: ${escapeHtml(payload.receiptId)}
    </div>

    <section class="details">
      <div class="full truncate">
        <strong>Customer:</strong> ${escapeHtml(payload.customerName)}
      </div>

      <div>
        <strong>Phone:</strong> ${escapeHtml(payload.phoneMasked || '-')}
      </div>

      <div>
        <strong>Payment:</strong> ${escapeHtml(payload.paymentMethod)}
      </div>

      <div class="full truncate">
        <strong>Product:</strong> ${escapeHtml(item.name)}
      </div>

      <div>
        <strong>SKU:</strong> ${escapeHtml(item.sku || '-')}
      </div>

      <div>
        <strong>Size:</strong> ${escapeHtml(item.size || '-')}
      </div>

      <div>
        <strong>Quantity:</strong> ${escapeHtml(String(item.quantity))}
      </div>
    </section>

    <div class="amount">
      Amount: ₹${escapeHtml(formatAmount(payload.total))}
    </div>

    <section class="barcode-area">
      ${barcodeSvg}
      <div class="barcode-text">${escapeHtml(payload.receiptId)}</div>
    </section>
  </main>
</body>
</html>`;
}

export function renderManualReceipt(
  payload: OfflineCustomerSlipPayload,
  size: LabelSizeInput = DEFAULT_LABEL_SIZE,
): Promise<string> {
  return renderManualReceiptHtml(payload, size);
}

export function renderOfflineCustomerSlip(
  payload: OfflineCustomerSlipPayload,
  size: LabelSizeInput = DEFAULT_LABEL_SIZE,
): Promise<string> {
  return renderManualReceiptHtml(payload, size);
}

interface ItemSummary {
  name: string;
  sku: string;
  size: string;
  quantity: number;
}

function summarizeItems(items: OfflineCustomerSlipPayload['items']): ItemSummary {
  const first = items[0]!;
  const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const suffix = items.length > 1 ? ` +${items.length - 1} more` : '';
  return {
    name: `${first.name}${suffix}`,
    sku: first.sku,
    size: first.size,
    quantity,
  };
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}
