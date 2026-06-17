import bwipjs from 'bwip-js';
import { LabelPayload } from './payload';
import { DEFAULT_LABEL_SIZE, resolveLabelSizeInput } from './profiles';
import type { LabelSizeInput } from './profiles';

export const TESTED_LABEL_CSS_4X3 = `@page {
  size: 101.6mm 76.2mm;
  margin: 0;
}

* {
  box-sizing: border-box;
}

html,
body {
  width: 101.6mm;
  height: 76.2mm;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #fff;
  color: #000;
  font-family: Arial, Helvetica, sans-serif;
}

.label {
  width: 101.6mm;
  height: 76.2mm;
  padding: 2.5mm 3mm 4mm;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding-bottom: 1.5mm;
  border-bottom: 0.6mm solid #000;
}

.brand {
  font-size: 18px;
  line-height: 1;
  font-weight: 800;
  letter-spacing: 0.4px;
}

.paid {
  border: 0.5mm solid #000;
  padding: 1mm 2.5mm;
  font-size: 12px;
  line-height: 1;
  font-weight: 800;
}

.order-id {
  margin-top: 1.5mm;
  font-size: 13px;
  line-height: 1.1;
  font-weight: 700;
}

.details {
  margin-top: 1mm;
  display: grid;
  grid-template-columns: 1.35fr 1fr;
  column-gap: 4mm;
  row-gap: 0.7mm;
  font-size: 10.5px;
  line-height: 1.08;
}

.full {
  grid-column: 1 / -1;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.amount {
  margin-top: 1.4mm;
  font-size: 15px;
  line-height: 1;
  font-weight: 800;
}

.barcode-area {
  margin-top: auto;
  height: 13mm;
  min-height: 13mm;
  text-align: center;
  overflow: hidden;
}

#barcode {
  display: block;
  width: 86mm;
  height: 9mm;
  margin: 0 auto;
}

.barcode-text {
  margin-top: 0.5mm;
  font-size: 9px;
  line-height: 1;
  letter-spacing: 1px;
}

@media print {
  html,
  body,
  .label {
    width: 101.6mm;
    height: 76.2mm;
  }
}`;

export function testedLabelCss(size: LabelSizeInput = DEFAULT_LABEL_SIZE): string {
  const resolved = resolveLabelSizeInput(size);
  if (resolved.name === '4x3') return TESTED_LABEL_CSS_4X3;
  return TESTED_LABEL_CSS_4X3
    .replace('size: 101.6mm 76.2mm;', 'size: 101.6mm 101.6mm;')
    .replaceAll('height: 76.2mm;', 'height: 101.6mm;');
}

export async function renderCode128BarcodeSvg(value: string): Promise<string> {
  const raw = bwipjs.toSVG({
    bcid: 'code128',
    text: value,
    scaleX: 1.7,
    scaleY: 1,
    height: 32,
    includetext: false,
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  });
  return raw.replace('<svg ', '<svg id="barcode" ');
}

export async function renderOnlineOrderHtml(
  payload: LabelPayload,
  size: LabelSizeInput = DEFAULT_LABEL_SIZE,
): Promise<string> {
  const barcodeSvg = await renderCode128BarcodeSvg(payload.barcodeValue);
  return htmlDocument(testedLabelCss(size), `<body>
  <main class="label">
    <header class="header">
      <div class="brand">KANIKA DESIGNS</div>
      <div class="paid">PAID</div>
    </header>

    <div class="order-id">
      Order ID: ${escapeHtml(payload.orderId)}
    </div>

    <section class="details">
      <div class="full truncate">
        <strong>Customer:</strong> ${escapeHtml(payload.customerName)}
      </div>

      <div>
        <strong>Phone:</strong> ${escapeHtml(phone(payload))}
      </div>

      <div>
        <strong>Pincode:</strong> ${escapeHtml(payload.pincode || '-')}
      </div>

      <div class="full truncate">
        <strong>Address:</strong> ${escapeHtml(compactAddress(payload))}
      </div>

      <div class="full truncate">
        <strong>Product:</strong> ${escapeHtml(payload.productName)}
      </div>

      <div>
        <strong>SKU:</strong> ${escapeHtml(payload.sku || '-')}
      </div>

      <div>
        <strong>Size:</strong> ${escapeHtml(payload.size || '-')}
      </div>

      <div>
        <strong>Quantity:</strong> ${escapeHtml(String(payload.quantity))}
      </div>

      <div>
        <strong>Payment:</strong> ${escapeHtml(payload.paymentType || payload.paymentStatus || '-')}
      </div>
    </section>

    <div class="amount">
      Amount: ₹${escapeHtml(formatAmount(payload.amount))}
    </div>

    <section class="barcode-area">
      ${barcodeSvg}
      <div class="barcode-text">${escapeHtml(payload.orderId)}</div>
    </section>
  </main>
</body>`);
}

export function renderOnlineOrderLabel(payload: LabelPayload, size: LabelSizeInput = DEFAULT_LABEL_SIZE): Promise<string> {
  return renderOnlineOrderHtml(payload, size);
}

export function renderOrderLabel(payload: LabelPayload, size: LabelSizeInput = DEFAULT_LABEL_SIZE): Promise<string> {
  return renderOnlineOrderHtml(payload, size);
}

export function renderTestLabelHtml(payload: LabelPayload, size: LabelSizeInput = DEFAULT_LABEL_SIZE): Promise<string> {
  return renderOnlineOrderHtml(payload, size);
}

export function renderTestLabel(payload: LabelPayload, size: LabelSizeInput = DEFAULT_LABEL_SIZE): Promise<string> {
  return renderTestLabelHtml(payload, size);
}

export function compactAddress(parts: {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
}): string {
  const joined = [parts.addressLine1, parts.addressLine2, parts.city, parts.state]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(', ');
  return joined || 'Not provided';
}

function htmlDocument(css: string, body: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
${css}
  </style>
</head>
${body}
</html>`;
}

function phone(payload: LabelPayload): string {
  return payload.phoneMasked || payload.maskedPhone || '-';
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}

export function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
