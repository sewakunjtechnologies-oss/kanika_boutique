import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { renderCode128BarcodePng } from './renderer';
import { getContentBox, mmToPt, resolveLabelProfile } from './profiles';
import type { LabelProfileInput } from './profiles';

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const BLACK = '#000000';

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
  labelProfile: z.literal('4x3_standard').default('4x3_standard'),
});

export type OfflineCustomerSlipPayload = z.infer<typeof OfflineCustomerSlipPayloadSchema>;

export function parseOfflineCustomerSlipPayload(value: unknown): OfflineCustomerSlipPayload {
  return OfflineCustomerSlipPayloadSchema.parse(value);
}

export interface OfflineSlipLayout {
  physicalWidthPt: number;
  physicalHeightPt: number;
  contentWidthPt: number;
  contentHeightPt: number;
  contentOffsetXPt: number;
  contentOffsetYPt: number;
}

export function computeOfflineSlipLayout(profileInput: LabelProfileInput = '4x3_standard'): OfflineSlipLayout {
  const profile = resolveLabelProfile(profileInput);
  const box = getContentBox(profile);
  return {
    physicalWidthPt: mmToPt(profile.widthMm),
    physicalHeightPt: mmToPt(profile.heightMm),
    contentWidthPt: mmToPt(box.widthMm),
    contentHeightPt: mmToPt(box.heightMm),
    contentOffsetXPt: mmToPt(box.offsetXmm),
    contentOffsetYPt: mmToPt(box.offsetYmm),
  };
}

export async function renderOfflineCustomerSlip(
  rawPayload: OfflineCustomerSlipPayload,
  profileInput: LabelProfileInput = '4x3_standard',
): Promise<Buffer> {
  const payload = parseOfflineCustomerSlipPayload(rawPayload);
  const profile = resolveLabelProfile(profileInput);
  const layout = computeOfflineSlipLayout(profile);
  const barcode = await renderCode128BarcodePng(payload.barcodeValue, 8);
  const doc = new PDFDocument({
    size: [layout.physicalWidthPt, layout.physicalHeightPt],
    margin: 0,
    bufferPages: false,
    autoFirstPage: true,
  });

  doc.info.CreationDate = new Date(0);
  doc.info.Producer = 'kda-labels';
  doc.info.Creator = 'kda-labels';
  doc.info.Title = `${payload.receiptId}-offline-slip`;

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.rect(0, 0, layout.physicalWidthPt, layout.physicalHeightPt).fill('#FFFFFF');
  doc.save();
  doc.translate(layout.contentOffsetXPt, layout.contentOffsetYPt);
  doc.fillColor(BLACK).strokeColor(BLACK);

  const pad = mmToPt(1.2);
  const x = pad;
  const w = layout.contentWidthPt - pad * 2;
  let y = mmToPt(1);

  y = text(doc, payload.storeName.toUpperCase(), x, y, w, { size: 12.5, bold: true, height: 14 });
  text(doc, 'Manual Receipt', x, mmToPt(1.5), w, { size: 7.5, align: 'right', height: 9 });
  y = twoCols(doc, x, y, w, payload.receiptId, shortDate(payload.createdAt), 7.6);
  y = twoCols(doc, x, y, w, safe(payload.customerName), payload.phoneMasked || '-', 7.4);
  y += mmToPt(0.6);
  line(doc, x, y, w);
  y += mmToPt(1.2);

  y = text(doc, 'Item', x, y, w, { size: 7, bold: true, height: 8 });
  const rows = compactItems(payload.items);
  for (const item of rows) {
    const left = `${item.name}${item.size ? ` / ${item.size}` : ''}`;
    const right = `x${item.quantity} Rs ${formatAmount(item.amount)}`;
    y = twoCols(doc, x, y, w, left, right, 7.1);
  }

  const totalsTop = mmToPt(39);
  y = Math.max(y + mmToPt(0.5), totalsTop);
  line(doc, x, y, w);
  y += mmToPt(1.2);
  y = twoCols(doc, x, y, w, 'Subtotal', `Rs ${formatAmount(payload.subtotal)}`, 7.2);
  y = twoCols(doc, x, y, w, 'Delivery', `Rs ${formatAmount(payload.delivery)}`, 7.2);
  y = twoCols(doc, x, y, w, 'Discount', `Rs ${formatAmount(payload.discount)}`, 7.2);
  y = twoCols(doc, x, y, w, 'Payment', payload.paymentMethod, 7.2);
  text(doc, `TOTAL: Rs ${formatAmount(payload.total)}`, x, y, w, { size: 9.4, bold: true, height: 11, align: 'right' });

  const barcodeY = layout.contentHeightPt - mmToPt(10.5);
  text(doc, 'Thank you', x, barcodeY - mmToPt(3.8), w, { size: 6.5, height: 7, align: 'center' });
  doc.image(barcode, x + mmToPt(8), barcodeY, {
    fit: [w - mmToPt(16), mmToPt(8)],
    align: 'center',
  });
  text(doc, payload.barcodeValue, x, barcodeY + mmToPt(8.2), w, { size: 6.2, height: 7, align: 'center' });

  doc.restore();
  doc.end();
  return done;
}

export function renderManualReceipt(
  payload: OfflineCustomerSlipPayload,
  profileInput: LabelProfileInput = '4x3_standard',
): Promise<Buffer> {
  return renderOfflineCustomerSlip(payload, profileInput);
}

function compactItems(items: OfflineCustomerSlipPayload['items']): OfflineCustomerSlipPayload['items'] {
  if (items.length <= 3) return items;
  const shown = items.slice(0, 2);
  const rest = items.slice(2);
  return [
    ...shown,
    {
      name: `+${rest.length} more item${rest.length === 1 ? '' : 's'}`,
      sku: '',
      size: '',
      quantity: rest.reduce((sum, item) => sum + item.quantity, 0),
      unitPrice: 0,
      amount: rest.reduce((sum, item) => sum + item.amount, 0),
    },
  ];
}

interface TextOptions {
  size: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  height?: number;
}

function text(
  doc: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  width: number,
  opts: TextOptions,
): number {
  const height = opts.height ?? opts.size + 2;
  doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(opts.size).fillColor(BLACK);
  doc.text(sanitize(value), x, y, {
    width,
    height,
    align: opts.align ?? 'left',
    lineBreak: false,
    ellipsis: true,
  });
  return y + height;
}

function twoCols(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  left: string,
  right: string,
  size: number,
): number {
  const gap = mmToPt(1.2);
  const leftW = width * 0.67;
  const rightW = width - leftW - gap;
  text(doc, left, x, y, leftW, { size, height: size + 2 });
  text(doc, right, x + leftW + gap, y, rightW, { size, height: size + 2, align: 'right' });
  return y + size + 2;
}

function line(doc: PDFKit.PDFDocument, x: number, y: number, width: number): void {
  doc.lineWidth(0.5).moveTo(x, y).lineTo(x + width, y).stroke();
}

function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}

function safe(value: string): string {
  return value || '-';
}

function sanitize(value: string): string {
  return String(value).replace(/₹/g, 'Rs ').replace(/\s+/g, ' ').trim();
}
