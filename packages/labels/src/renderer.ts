import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { LabelPayload } from './payload';
import {
  DEFAULT_LABEL_PROFILE,
  LabelProfile,
  LabelProfileInput,
  mmToPt,
  normalizeLabelProfileName,
  resolveLabelProfile,
} from './profiles';
import {
  BARCODE,
  ContentBox,
  DetailRow,
  compactAddress,
  contentBox,
  drawAmount,
  drawBarcodeArea,
  drawDetails,
  drawHeader,
  drawIdLine,
  formatAmount,
  paintPage,
} from './labelLayout';

export interface LabelRenderer {
  renderOnlineOrderLabel(payload: LabelPayload, profile: LabelProfileInput): Promise<Buffer>;
}

export interface LabelLayout {
  profile: LabelProfile;
  /** Physical PDF page (MediaBox) dimensions in points — 101.6 x 76.2 mm. */
  physicalWidthPt: number;
  physicalHeightPt: number;
  /** Content box inside the tested HTML padding. */
  box: ContentBox;
  barcodeAreaTopPt: number;
  barcodeWidthPt: number;
  barcodeHeightPt: number;
  /** PDF /Rotate — always 0. */
  rotation: 0;
  /** Output is always a single page. */
  pages: 1;
}

export function computeLabelLayout(_payload: LabelPayload, profileInput: LabelProfileInput): LabelLayout {
  const profile = resolveLabelProfile(profileInput);
  const box = contentBox();
  return {
    profile,
    physicalWidthPt: mmToPt(profile.widthMm),
    physicalHeightPt: mmToPt(profile.heightMm),
    box,
    barcodeAreaTopPt: box.bottom - mmToPt(BARCODE.areaHeightMm),
    barcodeWidthPt: mmToPt(BARCODE.widthMm),
    barcodeHeightPt: mmToPt(BARCODE.heightMm),
    rotation: 0,
    pages: 1,
  };
}

export async function renderCode128BarcodePng(value: string, heightMm: number): Promise<Buffer> {
  return bwipjs.toBuffer({
    bcid: 'code128',
    text: value,
    scale: 3,
    height: heightMm,
    includetext: false,
    monochrome: true,
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: 'FFFFFF',
    barcolor: '000000',
  });
}

function newLabelDoc(profile: LabelProfile): PDFKit.PDFDocument {
  // The PDF page is the PHYSICAL stock (101.6 x 76.2 mm). It carries no /Rotate.
  return new PDFDocument({
    size: [mmToPt(profile.widthMm), mmToPt(profile.heightMm)],
    margin: 0,
    bufferPages: false,
    autoFirstPage: true,
  });
}

function collect(doc: PDFKit.PDFDocument): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

export class PdfLabelRenderer implements LabelRenderer {
  async renderOnlineOrderLabel(payload: LabelPayload, profileInput: LabelProfileInput): Promise<Buffer> {
    const profile = resolveLabelProfile(profileInput);
    const box = contentBox();
    const barcode = await renderCode128BarcodePng(payload.barcodeValue, BARCODE.heightMm);

    const doc = newLabelDoc(profile);
    doc.info.CreationDate = new Date(0);
    doc.info.Producer = 'kda-labels';
    doc.info.Creator = 'kda-labels';
    doc.info.Title = `${payload.orderId}-${profile.name}`;
    const done = collect(doc);

    paintPage(doc);
    drawOnlineOrderBody(doc, payload, box, barcode);
    doc.end();
    return done;
  }
}

export const defaultLabelRenderer: LabelRenderer = new PdfLabelRenderer();

export function renderOrderLabel(
  payload: LabelPayload,
  profile: LabelProfileInput = payload.labelProfile ?? DEFAULT_LABEL_PROFILE,
): Promise<Buffer> {
  return renderOnlineOrderLabel(payload, profile);
}

export function renderOnlineOrderLabel(
  payload: LabelPayload,
  profile: LabelProfileInput = payload.labelProfile ?? DEFAULT_LABEL_PROFILE,
): Promise<Buffer> {
  if (typeof profile === 'object') return defaultLabelRenderer.renderOnlineOrderLabel(payload, profile);
  return defaultLabelRenderer.renderOnlineOrderLabel(payload, normalizeLabelProfileName(profile));
}

export function renderTestLabel(
  payload: LabelPayload,
  profile: LabelProfileInput = payload.labelProfile ?? DEFAULT_LABEL_PROFILE,
): Promise<Buffer> {
  return renderOnlineOrderLabel(payload, profile);
}

/**
 * TEMPLATE 2 — automated online order label (ORDER_LABEL). Same shared geometry
 * as the manual receipt, but its body adds the customer delivery address.
 */
function drawOnlineOrderBody(
  doc: PDFKit.PDFDocument,
  payload: LabelPayload,
  box: ContentBox,
  barcode: Buffer,
): void {
  const headerBottom = drawHeader(doc, box, payload.storeName, (payload.paymentStatus || 'PAID').toUpperCase());
  const idBottom = drawIdLine(doc, box, headerBottom, `Order ID: ${payload.orderId}`);

  const rows: DetailRow[] = [
    { type: 'full', label: 'Customer:', value: safeValue(payload.customerName) },
    {
      type: 'pair',
      left: { label: 'Phone:', value: phone(payload) },
      right: { label: 'Pincode:', value: payload.pincode || '-' },
    },
    { type: 'full', label: 'Address:', value: compactAddress(payload) },
    { type: 'full', label: 'Product:', value: safeValue(payload.productName) },
    {
      type: 'pair',
      left: { label: 'SKU:', value: payload.sku || '-' },
      right: { label: 'Size:', value: payload.size || '-' },
    },
    {
      type: 'pair',
      left: { label: 'Quantity:', value: String(payload.quantity) },
      right: { label: 'Payment:', value: (payload.paymentStatus || 'PAID').toUpperCase() },
    },
  ];
  const detailsBottom = drawDetails(doc, box, idBottom + mmToPt(1), rows);
  drawAmount(doc, box, detailsBottom, `Amount: Rs ${formatAmount(payload.amount)}`);
  drawBarcodeArea(doc, box, barcode, payload.barcodeValue);
}

function phone(payload: LabelPayload): string {
  return payload.phoneMasked || payload.maskedPhone || '-';
}

function safeValue(value: string): string {
  return value || '-';
}
