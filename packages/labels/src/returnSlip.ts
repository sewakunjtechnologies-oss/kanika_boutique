import { z } from 'zod';
import { DEFAULT_LABEL_SIZE } from './profiles';
import type { LabelSizeInput } from './profiles';
import { escapeHtml, renderCode128BarcodeSvg, testedLabelCss } from './renderer';

const ReturnSlipItemSchema = z.object({
  name: z.string().default('Item'),
  sku: z.string().default(''),
  size: z.string().default(''),
  quantity: z.number().int().positive(),
  refundAmount: z.number().nonnegative(),
});

export const ManualReceiptReturnSlipPayloadSchema = z.object({
  templateVersion: z.literal('manual-return-slip-v1'),
  storeName: z.string().min(1),
  receiptId: z.string().min(1),
  returnId: z.string().min(1),
  customerName: z.string().default('Walk-in customer'),
  phoneMasked: z.string().default(''),
  createdAt: z.string().min(1),
  refundMethod: z.string().min(1),
  refundAmount: z.number().nonnegative(),
  reason: z.string().min(1),
  items: z.array(ReturnSlipItemSchema).min(1),
  barcodeValue: z.string().min(1),
});

export type ManualReceiptReturnSlipPayload = z.infer<typeof ManualReceiptReturnSlipPayloadSchema>;

export function parseManualReceiptReturnSlipPayload(value: unknown): ManualReceiptReturnSlipPayload {
  return ManualReceiptReturnSlipPayloadSchema.parse(value);
}

export async function renderManualReceiptReturnSlipHtml(
  rawPayload: ManualReceiptReturnSlipPayload,
  size: LabelSizeInput = DEFAULT_LABEL_SIZE,
): Promise<string> {
  const payload = parseManualReceiptReturnSlipPayload(rawPayload);
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
      <div class="paid">RETURN</div>
    </header>

    <div class="order-id">
      Return ID: ${escapeHtml(payload.returnId)}
    </div>

    <section class="details">
      <div class="full truncate">
        <strong>Receipt:</strong> ${escapeHtml(payload.receiptId)}
      </div>

      <div class="full truncate">
        <strong>Customer:</strong> ${escapeHtml(payload.customerName)}
      </div>

      <div>
        <strong>Phone:</strong> ${escapeHtml(payload.phoneMasked || '-')}
      </div>

      <div>
        <strong>Refund:</strong> ${escapeHtml(payload.refundMethod)}
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

      <div class="full truncate">
        <strong>Reason:</strong> ${escapeHtml(payload.reason)}
      </div>
    </section>

    <div class="amount">
      Refund: ₹${escapeHtml(formatAmount(payload.refundAmount))}
    </div>

    <section class="barcode-area">
      ${barcodeSvg}
      <div class="barcode-text">${escapeHtml(payload.returnId)}</div>
    </section>
  </main>
</body>
</html>`;
}

interface ReturnItemSummary {
  name: string;
  sku: string;
  size: string;
  quantity: number;
}

function summarizeItems(items: ManualReceiptReturnSlipPayload['items']): ReturnItemSummary {
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
