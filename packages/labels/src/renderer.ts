import PDFDocument from 'pdfkit';
import bwipjs from 'bwip-js';
import { LabelPayload } from './payload';
import {
  LABEL_PROFILES,
  LabelProfile,
  LabelProfileName,
  mmToPt,
  resolveLabelProfile,
} from './profiles';

export interface LabelRenderer {
  renderOrderLabel(payload: LabelPayload, profile: LabelProfileName): Promise<Buffer>;
}

const FONT_REGULAR = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';
const BLACK = '#000000';

export interface LabelLayout {
  profile: LabelProfile;
  pageWidthPt: number;
  pageHeightPt: number;
  contentXPt: number;
  contentYPt: number;
  contentWidthPt: number;
  contentHeightPt: number;
  coreTopPt: number;
  coreBottomPt: number;
  barcodeAreaTopPt: number;
  barcodeAreaBottomPt: number;
  barcodeTopPt: number;
  barcodeBottomPt: number;
  physicalBottomSafePt: number;
  overflows: boolean;
}

export function computeLabelLayout(payload: LabelPayload, profileName: LabelProfileName): LabelLayout {
  const profile = LABEL_PROFILES[profileName] ?? resolveLabelProfile(profileName);
  const pageWidthPt = mmToPt(profile.widthMm);
  const pageHeightPt = mmToPt(profile.heightMm);
  const contentXPt = mmToPt(profile.marginLeftMm);
  const contentYPt = mmToPt(profile.marginTopMm);
  const contentWidthPt = mmToPt(profile.contentWidthMm);
  const contentHeightPt = mmToPt(profile.contentHeightMm);
  const barcodeAreaHeightPt = mmToPt(profile.barcodeAreaHeightMm);
  const barcodeHeightPt = mmToPt(profile.barcodeHeightMm);
  const barcodeAreaBottomPt = contentYPt + contentHeightPt;
  const barcodeAreaTopPt = barcodeAreaBottomPt - barcodeAreaHeightPt;
  const barcodeTopPt = barcodeAreaTopPt + mmToPt(1.1);
  const barcodeBottomPt = barcodeTopPt + barcodeHeightPt;
  const coreTopPt = contentYPt;
  const coreBottomPt = estimateCoreBottomPt(payload, profileName, coreTopPt);
  const physicalBottomSafePt = pageHeightPt - mmToPt(profile.marginBottomMm);

  return {
    profile,
    pageWidthPt,
    pageHeightPt,
    contentXPt,
    contentYPt,
    contentWidthPt,
    contentHeightPt,
    coreTopPt,
    coreBottomPt,
    barcodeAreaTopPt,
    barcodeAreaBottomPt,
    barcodeTopPt,
    barcodeBottomPt,
    physicalBottomSafePt,
    overflows:
      coreBottomPt > barcodeAreaTopPt - mmToPt(1.2) ||
      barcodeAreaBottomPt > physicalBottomSafePt + 0.5 ||
      contentXPt + contentWidthPt > pageWidthPt - mmToPt(profile.marginRightMm) + 0.5,
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
  async renderOrderLabel(payload: LabelPayload, profileName: LabelProfileName): Promise<Buffer> {
    const layout = computeLabelLayout(payload, profileName);
    if (layout.overflows) {
      throw new Error(`label content overflows ${profileName} safe area`);
    }

    const barcode = await renderCode128BarcodePng(payload.barcodeValue, layout.profile.barcodeHeightMm);
    const doc = new PDFDocument({
      size: [layout.pageWidthPt, layout.pageHeightPt],
      margin: 0,
      bufferPages: false,
      autoFirstPage: true,
    });

    doc.info.CreationDate = new Date(0);
    doc.info.Producer = 'kda-labels';
    doc.info.Creator = 'kda-labels';
    doc.info.Title = `${payload.orderId}-${profileName}`;

    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    drawLabel(doc, payload, profileName, layout, barcode);
    doc.end();
    return done;
  }
}

export const defaultLabelRenderer: LabelRenderer = new PdfLabelRenderer();

export function renderOrderLabel(
  payload: LabelPayload,
  profile: LabelProfileName = payload.labelProfile,
): Promise<Buffer> {
  return defaultLabelRenderer.renderOrderLabel(payload, profile);
}

function drawLabel(
  doc: PDFKit.PDFDocument,
  payload: LabelPayload,
  profileName: LabelProfileName,
  layout: LabelLayout,
  barcode: Buffer,
): void {
  const x = layout.contentXPt;
  const w = layout.contentWidthPt;
  let y = layout.coreTopPt;
  doc.fillColor(BLACK).strokeColor(BLACK);

  const write = (text: string, opts: TextOptions): void => {
    doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(opts.size);
    doc.text(sanitize(text), opts.x ?? x, y, {
      width: opts.width ?? w,
      height: opts.size + 2,
      align: opts.align ?? 'left',
      lineBreak: false,
      ellipsis: true,
    });
    y += opts.advance ?? opts.size + 2;
  };

  write(payload.storeName.toUpperCase(), { size: 17, bold: true, align: 'center', advance: 18 });

  const paidW = mmToPt(16);
  doc.lineWidth(1).rect(x + w - paidW, y - 15, paidW, 13).stroke();
  doc.font(FONT_BOLD).fontSize(8).text('PAID', x + w - paidW, y - 12.5, {
    width: paidW,
    align: 'center',
    lineBreak: false,
  });

  doc.lineWidth(0.7).moveTo(x, y).lineTo(x + w, y).stroke();
  y += 3;

  write(`Order ${payload.orderId}`, { size: 12, bold: true, advance: 14 });
  write(`Customer: ${payload.customerName || '-'}`, { size: 9.6, advance: 11 });

  const rowGap = 1;
  writeTwoColumns(doc, x, y, w, `Phone: ${payload.maskedPhone || '-'}`, `PIN: ${payload.pincode || '-'}`);
  y += 11 + rowGap;

  write(`Product: ${payload.productName || '-'}`, { size: 9.6, advance: 11 });
  write(`SKU: ${payload.sku || '-'}`, { size: 9.6, advance: 11 });

  writeTwoColumns(doc, x, y, w, `Size: ${payload.size || '-'}`, `Qty: ${payload.quantity}`);
  y += 11 + rowGap;

  writeTwoColumns(doc, x, y, w, `Payment: ${payload.paymentType || 'UPI'}`, `Amount: Rs ${formatAmount(payload.amount)}`, true);
  y += 14;

  if (profileName === '4x4') {
    const extraBottom = layout.barcodeAreaTopPt - mmToPt(2);
    if (payload.addressLine && y + 10 < extraBottom) {
      write(`Address: ${payload.addressLine}`, { size: 9, advance: 10 });
    }
  }

  doc.image(barcode, x + mmToPt(1.5), layout.barcodeTopPt, {
    fit: [w - mmToPt(3), mmToPt(layout.profile.barcodeHeightMm)],
    align: 'center',
  });
  doc.font(FONT_REGULAR).fontSize(7.4).fillColor(BLACK);
  doc.text(sanitize(payload.barcodeValue), x, layout.barcodeBottomPt + mmToPt(0.6), {
    width: w,
    height: mmToPt(2.8),
    align: 'center',
    lineBreak: false,
    ellipsis: true,
  });
}

interface TextOptions {
  size: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  advance?: number;
  x?: number;
  width?: number;
}

function writeTwoColumns(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  left: string,
  right: string,
  rightBold = false,
): void {
  const gap = mmToPt(2);
  const colW = (w - gap) / 2;
  doc.font(FONT_REGULAR).fontSize(9.6).text(sanitize(left), x, y, {
    width: colW,
    height: 12,
    lineBreak: false,
    ellipsis: true,
  });
  doc.font(rightBold ? FONT_BOLD : FONT_REGULAR).fontSize(rightBold ? 13.2 : 9.6).text(sanitize(right), x + colW + gap, y, {
    width: colW,
    height: 15,
    align: 'right',
    lineBreak: false,
    ellipsis: true,
  });
}

function estimateCoreBottomPt(payload: LabelPayload, profileName: LabelProfileName, topPt: number): number {
  let bottom = topPt;
  bottom += 18; // brand
  bottom += 3; // divider
  bottom += 14; // order
  bottom += 11; // customer
  bottom += 12; // phone/pin
  bottom += 11; // product
  bottom += 11; // sku
  bottom += 12; // size/qty
  bottom += 14; // payment/amount
  if (profileName === '4x4' && payload.addressLine) bottom += 10;
  return bottom;
}

function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}

function sanitize(value: string): string {
  return String(value).replace(/₹/g, 'Rs ').replace(/\s+/g, ' ').trim();
}
