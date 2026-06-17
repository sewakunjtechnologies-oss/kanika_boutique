import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { renderCode128BarcodePng } from './renderer';
import { mmToPt, resolveLabelProfile } from './profiles';
import type { LabelProfileInput } from './profiles';
import {
  BARCODE,
  ContentBox,
  DetailRow,
  contentBox,
  drawAmount,
  drawBarcodeArea,
  drawDetails,
  drawHeader,
  drawIdLine,
  formatAmount,
  paintPage,
} from './labelLayout';

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
  box: ContentBox;
  rotation: 0;
  pages: 1;
}

export function computeOfflineSlipLayout(profileInput: LabelProfileInput = '4x3_standard'): OfflineSlipLayout {
  const profile = resolveLabelProfile(profileInput);
  return {
    physicalWidthPt: mmToPt(profile.widthMm),
    physicalHeightPt: mmToPt(profile.heightMm),
    box: contentBox(),
    rotation: 0,
    pages: 1,
  };
}

/**
 * TEMPLATE 1 — manual receipt (OFFLINE_CUSTOMER_SLIP). Shares the tested 4x3
 * geometry with the online label but deliberately carries NO address, courier
 * or shipping fields.
 */
export async function renderOfflineCustomerSlip(
  rawPayload: OfflineCustomerSlipPayload,
  profileInput: LabelProfileInput = '4x3_standard',
): Promise<Buffer> {
  const payload = parseOfflineCustomerSlipPayload(rawPayload);
  const profile = resolveLabelProfile(profileInput);
  const box = contentBox();
  const barcode = await renderCode128BarcodePng(payload.barcodeValue, BARCODE.heightMm);

  const doc = new PDFDocument({
    size: [mmToPt(profile.widthMm), mmToPt(profile.heightMm)],
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

  paintPage(doc);
  drawManualReceiptBody(doc, payload, box, barcode);
  doc.end();
  return done;
}

export function renderManualReceipt(
  payload: OfflineCustomerSlipPayload,
  profileInput: LabelProfileInput = '4x3_standard',
): Promise<Buffer> {
  return renderOfflineCustomerSlip(payload, profileInput);
}

function drawManualReceiptBody(
  doc: PDFKit.PDFDocument,
  payload: OfflineCustomerSlipPayload,
  box: ContentBox,
  barcode: Buffer,
): void {
  const product = summarizeItems(payload.items);
  const headerBottom = drawHeader(doc, box, payload.storeName, 'RECEIPT');
  const idBottom = drawIdLine(doc, box, headerBottom, `Receipt ID: ${payload.receiptId}`);

  const rows: DetailRow[] = [
    { type: 'full', label: 'Customer:', value: safe(payload.customerName) },
    {
      type: 'pair',
      left: { label: 'Phone:', value: payload.phoneMasked || '-' },
      right: { label: 'Payment:', value: payload.paymentMethod },
    },
    { type: 'full', label: 'Product:', value: product.name },
    {
      type: 'pair',
      left: { label: 'SKU:', value: product.sku || '-' },
      right: { label: 'Size:', value: product.size || '-' },
    },
    { type: 'pair', left: { label: 'Quantity:', value: String(product.quantity) } },
  ];
  const detailsBottom = drawDetails(doc, box, idBottom + mmToPt(1), rows);
  drawAmount(doc, box, detailsBottom, `Amount: Rs ${formatAmount(payload.total)}`);
  drawBarcodeArea(doc, box, barcode, payload.barcodeValue);
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

function safe(value: string): string {
  return value || '-';
}
