// Shared label geometry — the single source of truth that mirrors the manually
// tested 4x3 HTML label (101.6 x 76.2 mm, padding 2.5mm 3mm 4mm).
//
// IMPORTANT: this module is the "CSS only" both templates share. The manual
// receipt and the online order label use these helpers for identical geometry,
// fonts, spacing, grid structure and barcode dimensions, but build DIFFERENT
// body structures on top of it. Do not introduce a second set of dimensions,
// a 96x68 canvas, a rotated/landscape profile or any width/height swap here.

import { mmToPt } from './profiles';

export const FONT_REGULAR = 'Helvetica';
export const FONT_BOLD = 'Helvetica-Bold';
export const BLACK = '#000000';
export const WHITE = '#FFFFFF';

/** Physical label page — matches the tested HTML @page exactly. */
export const PAGE = { widthMm: 101.6, heightMm: 76.2 } as const;

/** .label padding: 2.5mm top, 3mm right, 4mm bottom, 3mm left. */
export const PAD = { topMm: 2.5, rightMm: 3, bottomMm: 4, leftMm: 3 } as const;

/** Tested barcode geometry: 86mm x 9mm inside a 13mm reserved area. */
export const BARCODE = { widthMm: 86, heightMm: 9, areaHeightMm: 13 } as const;

/** Convert CSS px (96 dpi) → PDF points (72 dpi). 1px = 0.75pt. */
export function pxToPt(px: number): number {
  return (px * 72) / 96;
}

/** Font sizes from the tested HTML, in points. */
export const FONT_SIZES = {
  brand: pxToPt(18), // .brand
  badge: pxToPt(12), // .paid
  orderId: pxToPt(13), // .order-id
  details: pxToPt(10.5), // .details
  amount: pxToPt(15), // .amount
  barcodeText: pxToPt(9), // .barcode-text
} as const;

export interface ContentBox {
  /** Left edge inside .label padding (points). */
  x: number;
  /** Top edge inside .label padding (points). */
  y: number;
  /** Content width inside left/right padding (points). */
  w: number;
  /** Bottom edge inside .label padding (points). */
  bottom: number;
  /** Content height between top and bottom padding (points). */
  h: number;
}

/** The content box inside .label padding on the full physical page. */
export function contentBox(): ContentBox {
  const x = mmToPt(PAD.leftMm);
  const y = mmToPt(PAD.topMm);
  const w = mmToPt(PAGE.widthMm - PAD.leftMm - PAD.rightMm);
  const bottom = mmToPt(PAGE.heightMm - PAD.bottomMm);
  return { x, y, w, bottom, h: bottom - y };
}

/** .details grid columns: 1.35fr / 1fr with a 4mm column gap. */
export function detailsColumns(contentWidthPt: number): { gap: number; col1: number; col2: number } {
  const gap = mmToPt(4);
  const usable = contentWidthPt - gap;
  return {
    gap,
    col1: (usable * 1.35) / 2.35,
    col2: (usable * 1) / 2.35,
  };
}

export function sanitize(value: string): string {
  // Helvetica (WinAnsi) has no ₹ glyph; the tested PDF path renders it as "Rs ".
  return String(value).replace(/₹/g, 'Rs ').replace(/\s+/g, ' ').trim();
}

interface LineOptions {
  size: number;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
}

/** Single non-wrapping line, truncated with an ellipsis (mirrors .truncate). */
export function lineText(
  doc: PDFKit.PDFDocument,
  value: string,
  x: number,
  y: number,
  w: number,
  opts: LineOptions,
): void {
  doc.font(opts.bold ? FONT_BOLD : FONT_REGULAR).fontSize(opts.size).fillColor(BLACK);
  doc.text(sanitize(value), x, y, {
    width: w,
    align: opts.align ?? 'left',
    lineBreak: false,
    ellipsis: true,
  });
}

/** A `<strong>Label:</strong> value` details cell with a truncated value. */
export function detailCell(
  doc: PDFKit.PDFDocument,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  size: number,
): void {
  const labelText = `${label} `;
  doc.font(FONT_BOLD).fontSize(size).fillColor(BLACK);
  const labelWidth = Math.min(doc.widthOfString(labelText), w);
  doc.text(labelText, x, y, { width: w, lineBreak: false, ellipsis: false });
  doc.font(FONT_REGULAR).fontSize(size).fillColor(BLACK);
  doc.text(sanitize(value), x + labelWidth, y, {
    width: Math.max(0, w - labelWidth),
    lineBreak: false,
    ellipsis: true,
  });
}

/** Draw the brand + badge header and its bottom rule. Returns the y below it. */
export function drawHeader(
  doc: PDFKit.PDFDocument,
  box: ContentBox,
  brand: string,
  badgeText: string,
): number {
  const badge = badgeText.toUpperCase();
  const badgePadX = mmToPt(2.5);
  const badgePadY = mmToPt(1);

  doc.font(FONT_BOLD).fontSize(FONT_SIZES.badge);
  const badgeW = doc.widthOfString(badge) + badgePadX * 2;
  const badgeH = FONT_SIZES.badge + badgePadY * 2;
  const brandH = FONT_SIZES.brand;
  const rowH = Math.max(brandH, badgeH);

  lineText(doc, brand.toUpperCase(), box.x, box.y + (rowH - brandH) / 2, box.w - badgeW - mmToPt(2), {
    size: FONT_SIZES.brand,
    bold: true,
  });

  const badgeX = box.x + box.w - badgeW;
  const badgeY = box.y + (rowH - badgeH) / 2;
  doc.lineWidth(mmToPt(0.5)).strokeColor(BLACK).rect(badgeX, badgeY, badgeW, badgeH).stroke();
  lineText(doc, badge, badgeX, badgeY + badgePadY, badgeW, {
    size: FONT_SIZES.badge,
    bold: true,
    align: 'center',
  });

  const ruleY = box.y + rowH + mmToPt(1.5);
  doc.lineWidth(mmToPt(0.6)).strokeColor(BLACK).moveTo(box.x, ruleY).lineTo(box.x + box.w, ruleY).stroke();
  return ruleY + mmToPt(0.6);
}

/** Draw the bold id line (Order/Receipt). Returns the y below it. */
export function drawIdLine(doc: PDFKit.PDFDocument, box: ContentBox, headerBottom: number, text: string): number {
  const y = headerBottom + mmToPt(1.5);
  lineText(doc, text, box.x, y, box.w, { size: FONT_SIZES.orderId, bold: true });
  return y + FONT_SIZES.orderId * 1.1;
}

export type DetailRow =
  | { type: 'full'; label: string; value: string }
  | { type: 'pair'; left: { label: string; value: string }; right?: { label: string; value: string } };

/** Draw the .details grid. Returns the y below the last row. */
export function drawDetails(doc: PDFKit.PDFDocument, box: ContentBox, startY: number, rows: DetailRow[]): number {
  const size = FONT_SIZES.details;
  const lineH = size * 1.08;
  const rowGap = mmToPt(0.7);
  const cols = detailsColumns(box.w);
  let y = startY;
  rows.forEach((row, index) => {
    if (index > 0) y += rowGap;
    if (row.type === 'full') {
      detailCell(doc, box.x, y, box.w, row.label, row.value, size);
    } else {
      detailCell(doc, box.x, y, cols.col1, row.left.label, row.left.value, size);
      if (row.right) {
        detailCell(doc, box.x + cols.col1 + cols.gap, y, cols.col2, row.right.label, row.right.value, size);
      }
    }
    y += lineH;
  });
  return y;
}

/** Draw the .amount line (margin-top 1.4mm). Returns the y below it. */
export function drawAmount(doc: PDFKit.PDFDocument, box: ContentBox, y: number, amountText: string): number {
  const top = y + mmToPt(1.4);
  lineText(doc, amountText, box.x, top, box.w, { size: FONT_SIZES.amount, bold: true });
  return top + FONT_SIZES.amount;
}

/** Pin the barcode area (86x9mm in a 13mm band) to the bottom of the content box. */
export function drawBarcodeArea(
  doc: PDFKit.PDFDocument,
  box: ContentBox,
  barcodePng: Buffer,
  humanText: string,
): void {
  const areaTop = box.bottom - mmToPt(BARCODE.areaHeightMm);
  const barW = mmToPt(BARCODE.widthMm);
  const barH = mmToPt(BARCODE.heightMm);
  const barX = box.x + (box.w - barW) / 2;
  doc.image(barcodePng, barX, areaTop, { fit: [barW, barH], align: 'center' });
  lineText(doc, humanText, box.x, areaTop + barH + mmToPt(0.5), box.w, {
    size: FONT_SIZES.barcodeText,
    align: 'center',
  });
}

/** Paint the full physical page white and reset the draw colour to black. */
export function paintPage(doc: PDFKit.PDFDocument): void {
  doc.rect(0, 0, mmToPt(PAGE.widthMm), mmToPt(PAGE.heightMm)).fill(WHITE);
  doc.fillColor(BLACK).strokeColor(BLACK);
}

/** Build the compact, single-line delivery address (no pincode). */
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

export function formatAmount(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toString() : '0';
}
