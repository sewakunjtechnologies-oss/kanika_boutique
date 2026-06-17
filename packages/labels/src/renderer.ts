import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { LabelPayload } from './payload';
import {
  DEFAULT_LABEL_PROFILE,
  LABEL_PROFILES,
  LabelProfile,
  LabelProfileInput,
  LabelProfileName,
  getContentBox,
  mmToPt,
  normalizeLabelProfileName,
  resolveLabelProfile,
} from './profiles';

export interface LabelRenderer {
  renderOnlineOrderLabel(payload: LabelPayload, profile: LabelProfileInput): Promise<Buffer>;
}

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const BLACK = '#000000';

export interface LabelLayout {
  profile: LabelProfile;
  /** Physical PDF page (MediaBox) dimensions in points. */
  physicalWidthPt: number;
  physicalHeightPt: number;
  /**
   * Logical design-canvas dimensions in points. All content below is laid out
   * in this space; compact profiles center this canvas inside the physical page.
   */
  pageWidthPt: number;
  pageHeightPt: number;
  safeXPt: number;
  safeYPt: number;
  safeWidthPt: number;
  safeHeightPt: number;
  bodyTopPt: number;
  bodyBottomPt: number;
  barcodeAreaTopPt: number;
  barcodeAreaBottomPt: number;
  barcodeTopPt: number;
  barcodeBottomPt: number;
  physicalBottomSafePt: number;
  contentOffsetXPt: number;
  contentOffsetYPt: number;
  overflows: boolean;
}

export function computeLabelLayout(payload: LabelPayload, profileInput: LabelProfileInput): LabelLayout {
  const profile = resolveLabelProfile(profileInput);
  const contentBox = getContentBox(profile);
  // Physical page = PDF MediaBox the printer receives. Logical canvas = the
  // centered content box where the label design is laid out.
  const physicalWidthPt = mmToPt(profile.widthMm);
  const physicalHeightPt = mmToPt(profile.heightMm);
  const pageWidthPt = mmToPt(profile.designWidthMm);
  const pageHeightPt = mmToPt(profile.designHeightMm);
  const safeXPt = mmToPt(profile.marginLeftMm);
  const safeYPt = mmToPt(profile.marginTopMm);
  const safeWidthPt = mmToPt(profile.safeWidthMm);
  const safeHeightPt = mmToPt(profile.safeHeightMm);
  const barcodeAreaHeightPt = mmToPt(profile.barcodeAreaHeightMm);
  const barcodeHeightPt = mmToPt(profile.barcodeHeightMm);
  const physicalBottomSafePt = pageHeightPt - mmToPt(profile.marginBottomMm);
  const barcodeAreaBottomPt = Math.min(safeYPt + safeHeightPt, physicalBottomSafePt);
  const barcodeAreaTopPt = barcodeAreaBottomPt - barcodeAreaHeightPt;
  const barcodeTopPt = barcodeAreaTopPt + mmToPt(1);
  const barcodeBottomPt = barcodeTopPt + barcodeHeightPt;
  const bodyTopPt = safeYPt;
  const bodyBottomPt = estimateWide4x3BodyBottomPt(bodyTopPt);
  return {
    profile,
    physicalWidthPt,
    physicalHeightPt,
    pageWidthPt,
    pageHeightPt,
    safeXPt,
    safeYPt,
    safeWidthPt,
    safeHeightPt,
    bodyTopPt,
    bodyBottomPt,
    barcodeAreaTopPt,
    barcodeAreaBottomPt,
    barcodeTopPt,
    barcodeBottomPt,
    physicalBottomSafePt,
    contentOffsetXPt: mmToPt(contentBox.offsetXmm),
    contentOffsetYPt: mmToPt(contentBox.offsetYmm),
    overflows:
      bodyBottomPt > barcodeAreaTopPt - mmToPt(1) ||
      barcodeAreaBottomPt > physicalBottomSafePt + 0.5 ||
      safeXPt + safeWidthPt > pageWidthPt - mmToPt(profile.marginRightMm) + 0.5,
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

export class PdfLabelRenderer implements LabelRenderer {
  async renderOnlineOrderLabel(payload: LabelPayload, profileInput: LabelProfileInput): Promise<Buffer> {
    const profile = resolveLabelProfile(profileInput);
    const layout = computeLabelLayout(payload, profile);
    if (layout.overflows) {
      throw new Error(`label content overflows ${profile.name} safe area`);
    }

    const barcode = await renderCode128BarcodePng(payload.barcodeValue, layout.profile.barcodeHeightMm);
    // The PDF page is the PHYSICAL stock. Content is laid out in the logical
    // canvas centered on that page. The page itself carries no /Rotate.
    const doc = new PDFDocument({
      size: [layout.physicalWidthPt, layout.physicalHeightPt],
      margin: 0,
      bufferPages: false,
      autoFirstPage: true,
    });

    doc.info.CreationDate = new Date(0);
    doc.info.Producer = 'kda-labels';
    doc.info.Creator = 'kda-labels';
    doc.info.Title = `${payload.orderId}-${profile.name}`;

    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    doc.rect(0, 0, layout.physicalWidthPt, layout.physicalHeightPt).fill('#FFFFFF');
    doc.fillColor(BLACK).strokeColor(BLACK);

    doc.save();
    doc.translate(layout.contentOffsetXPt, layout.contentOffsetYPt);

    doc.rect(0, 0, layout.pageWidthPt, layout.pageHeightPt).fill('#FFFFFF');
    doc.fillColor(BLACK).strokeColor(BLACK);

    drawWide4x3Label(doc, payload, layout, barcode);
    doc.restore();
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

function drawWide4x3Label(
  doc: PDFKit.PDFDocument,
  payload: LabelPayload,
  layout: LabelLayout,
  barcode: Buffer,
): void {
  const x = layout.safeXPt;
  const w = layout.safeWidthPt;
  let y = layout.safeYPt;
  doc.fillColor(BLACK).strokeColor(BLACK);

  drawTopRow(doc, payload, layout, y, 17, 16);
  y += 18;
  text(doc, `Order: ${payload.orderId}`, x, y, w, { size: 11.5, bold: true, height: 13 });
  y += 14;

  const gap = mmToPt(2.2);
  const leftW = mmToPt(58);
  const rightW = w - leftW - gap;
  const leftX = x;
  const rightX = x + leftW + gap;
  let leftY = y;
  let rightY = y;

  leftY = text(doc, safeValue(payload.customerName), leftX, leftY, leftW, { size: 10, bold: true, height: 11 });
  leftY = text(doc, `Phone: ${phone(payload)}`, leftX, leftY, leftW, { size: 9.2, height: 10 });
  for (const line of compactAddressLines(payload)) {
    leftY = text(doc, line, leftX, leftY, leftW, { size: 8.5, height: 9.4 });
  }

  rightY = text(doc, safeValue(payload.productName), rightX, rightY, rightW, { size: 9.3, bold: true, height: 11 });
  rightY = text(doc, `SKU: ${payload.sku || '-'}`, rightX, rightY, rightW, { size: 8.8, height: 10 });
  rightY = twoColumnText(doc, rightX, rightY, rightW, `Size: ${payload.size || '-'}`, `Qty: ${payload.quantity}`, 8.8);
  rightY = text(doc, `Amt: Rs ${formatAmount(payload.amount)}`, rightX, rightY + 1, rightW, {
    size: 11.8,
    bold: true,
    height: 14,
    align: 'right',
  });
  text(doc, `Payment: ${(payload.paymentStatus || 'PAID').toUpperCase()}`, rightX, rightY, rightW, {
    size: 8.5,
    height: 10,
    align: 'right',
  });

  drawBarcode(doc, payload, layout, barcode);
}

function drawTopRow(
  doc: PDFKit.PDFDocument,
  payload: LabelPayload,
  layout: LabelLayout,
  y: number,
  brandSize: number,
  badgeWidthMm: number,
): void {
  const x = layout.safeXPt;
  const w = layout.safeWidthPt;
  const badgeW = mmToPt(badgeWidthMm);
  const badgeH = mmToPt(6);
  text(doc, payload.storeName.toUpperCase(), x, y, w - badgeW - mmToPt(2), {
    size: brandSize,
    bold: true,
    height: badgeH + 1,
  });
  doc.lineWidth(1).rect(x + w - badgeW, y, badgeW, badgeH).stroke();
  text(doc, (payload.paymentStatus || 'PAID').toUpperCase(), x + w - badgeW, y + mmToPt(0.7), badgeW, {
    size: 8.5,
    bold: true,
    height: badgeH,
    align: 'center',
  });
}

function drawBarcode(
  doc: PDFKit.PDFDocument,
  payload: LabelPayload,
  layout: LabelLayout,
  barcode: Buffer,
): void {
  const x = layout.safeXPt;
  const w = layout.safeWidthPt;
  doc.image(barcode, x + mmToPt(2), layout.barcodeTopPt, {
    fit: [w - mmToPt(4), mmToPt(layout.profile.barcodeHeightMm)],
    align: 'center',
  });
  text(doc, payload.barcodeValue, x, layout.barcodeBottomPt + mmToPt(0.7), w, {
    size: 7.4,
    height: mmToPt(3),
    align: 'center',
  });
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

function twoColumnText(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  width: number,
  left: string,
  right: string,
  size: number,
): number {
  const gap = mmToPt(2);
  const colW = (width - gap) / 2;
  text(doc, left, x, y, colW, { size, height: size + 3 });
  text(doc, right, x + colW + gap, y, colW, { size, height: size + 3, align: 'right' });
  return y + size + 3;
}

function estimateWide4x3BodyBottomPt(topPt: number): number {
  return topPt + 18 + 14 + 55;
}

function phone(payload: LabelPayload): string {
  return payload.phoneMasked || payload.maskedPhone || '-';
}

function compactAddressLines(payload: LabelPayload): string[] {
  const primary = payload.addressLine1 || payload.addressLine;
  const locality = [payload.city, payload.state].filter(Boolean).join(', ');
  const pin = payload.pincode ? `PIN: ${payload.pincode}` : '';
  return [
    primary,
    payload.addressLine2,
    [locality, pin].filter(Boolean).join(' '),
  ].map((line) => line.trim()).filter(Boolean).slice(0, 3);
}

function safeValue(value: string): string {
  return value || '-';
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}

function sanitize(value: string): string {
  return String(value).replace(/₹/g, 'Rs ').replace(/\s+/g, ' ').trim();
}
