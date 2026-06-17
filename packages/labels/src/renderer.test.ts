import { describe, expect, test } from 'vitest';
import { LabelPayload, parseLabelPayload } from './payload';
import { LABEL_PROFILES, mmToPt } from './profiles';
import { FONT_SIZES, PAD, PAGE, BARCODE, contentBox, pxToPt } from './labelLayout';
import { computeLabelLayout, renderCode128BarcodePng, renderOnlineOrderLabel, renderOrderLabel } from './renderer';
import { countPdfPages, extractPdfText, readPdfRotation, validateLabelPdfSize } from './validate';

const payload: LabelPayload = {
  templateVersion: 'online-order-label-v1',
  storeName: 'Kanika Designs',
  orderId: 'KDA-2026-000123',
  customerName: 'Customer With A Very Very Long Name That Must Not Wrap',
  maskedPhone: '98XXXXXX21',
  phoneMasked: '98XXXXXX21',
  productName: 'Blue Floral Pure Cotton Suit With Dupatta And Very Long Product Name',
  sku: 'ARTICLE-1-BLUE-FLORAL',
  size: '40',
  quantity: 2,
  amount: 4540,
  paymentStatus: 'PAID',
  paymentType: 'UPI',
  barcodeValue: 'KDA-2026-000123',
  addressLine: 'H.No. 25, Sector 14',
  addressLine1: 'H.No. 25, Sector 14',
  addressLine2: 'Near Main Market',
  city: 'Sonipat',
  state: 'Haryana',
  pincode: '110001',
  labelProfile: '4x3_standard',
};

describe('online order label renderer', () => {
  test('PDF is exactly 101.6 x 76.2 mm, one page, no rotation (matches tested HTML page)', async () => {
    const pdf = await renderOnlineOrderLabel(payload, '4x3_standard');
    const result = validateLabelPdfSize(pdf, '4x3_standard', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
    expect(result.actual!.widthPt).toBeGreaterThan(result.actual!.heightPt);
    expect(result.rotation).toBe(0);
    expect(readPdfRotation(pdf)).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(LABEL_PROFILES['4x3_standard'].orientation).toBe('portrait');
    expect(LABEL_PROFILES['4x3_standard'].rendererRotation).toBe(0);
    expect(LABEL_PROFILES['4x3_standard'].rotation).toBe(0);
  });

  test('uses the full physical page as the canvas — no 96x68 profile', () => {
    const profile = LABEL_PROFILES['4x3_standard'];
    expect(profile.designWidthMm).toBe(101.6);
    expect(profile.designHeightMm).toBe(76.2);
    expect(profile.contentWidthMm).toBe(101.6);
    expect(profile.contentHeightMm).toBe(76.2);
    expect(profile.offsetXmm).toBe(0);
    expect(profile.offsetYmm).toBe(0);
    // The tested-HTML padding is preserved, not a centered sub-canvas.
    expect(profile.marginTopMm).toBe(PAD.topMm);
    expect(profile.marginRightMm).toBe(PAD.rightMm);
    expect(profile.marginBottomMm).toBe(PAD.bottomMm);
    expect(profile.marginLeftMm).toBe(PAD.leftMm);
  });

  test('layout content box matches the tested HTML padding (2.5/3/4mm)', () => {
    const layout = computeLabelLayout(payload, '4x3_standard');
    const box = contentBox();

    expect(layout.physicalWidthPt).toBeCloseTo(mmToPt(PAGE.widthMm), 5);
    expect(layout.physicalHeightPt).toBeCloseTo(mmToPt(PAGE.heightMm), 5);
    expect(box.x).toBeCloseTo(mmToPt(PAD.leftMm), 5);
    expect(box.y).toBeCloseTo(mmToPt(PAD.topMm), 5);
    expect(box.w).toBeCloseTo(mmToPt(PAGE.widthMm - PAD.leftMm - PAD.rightMm), 5);
    expect(box.bottom).toBeCloseTo(mmToPt(PAGE.heightMm - PAD.bottomMm), 5);
    expect(layout.rotation).toBe(0);
    expect(layout.pages).toBe(1);
  });

  test('barcode dimensions are unchanged (86 x 9 mm in a 13mm band)', () => {
    expect(BARCODE.widthMm).toBe(86);
    expect(BARCODE.heightMm).toBe(9);
    expect(BARCODE.areaHeightMm).toBe(13);
    const layout = computeLabelLayout(payload, '4x3_standard');
    expect(layout.barcodeWidthPt).toBeCloseTo(mmToPt(86), 5);
    expect(layout.barcodeHeightPt).toBeCloseTo(mmToPt(9), 5);
    expect(layout.barcodeAreaTopPt).toBeCloseTo(mmToPt(PAGE.heightMm - PAD.bottomMm - 13), 5);
  });

  test('font sizes are unchanged (derived from the tested HTML px values)', () => {
    expect(FONT_SIZES.brand).toBeCloseTo(pxToPt(18), 6);
    expect(FONT_SIZES.badge).toBeCloseTo(pxToPt(12), 6);
    expect(FONT_SIZES.orderId).toBeCloseTo(pxToPt(13), 6);
    expect(FONT_SIZES.details).toBeCloseTo(pxToPt(10.5), 6);
    expect(FONT_SIZES.amount).toBeCloseTo(pxToPt(15), 6);
    expect(FONT_SIZES.barcodeText).toBeCloseTo(pxToPt(9), 6);
  });

  test('online order label PDF carries the address and pincode text', async () => {
    const pdf = await renderOnlineOrderLabel(payload, '4x3_standard');
    const text = extractPdfText(pdf);
    expect(text).toContain('Address:');
    expect(text).toContain('Pincode:');
  });

  test('long names and long address truncate without extra pages', async () => {
    const longPayload = parseLabelPayload({
      ...payload,
      addressLine1: 'Very long house number and tower name that should truncate cleanly',
      addressLine2: 'Near a very long landmark and market road that should not overlap product data',
      city: 'Sonipat With Long Locality Name',
      state: 'Haryana',
      productName: 'Extremely Long Product Name That Should Be Cut Off With An Ellipsis Without Wrapping',
    });
    const pdf = await renderOnlineOrderLabel(longPayload, '4x3_standard');

    expect(countPdfPages(pdf)).toBe(1);
    expect(validateLabelPdfSize(pdf, '4x3_standard', 0.6).ok).toBe(true);
    expect(readPdfRotation(pdf)).toBe(0);
  });

  test('renderOrderLabel is an alias for the online order renderer', async () => {
    const pdf = await renderOrderLabel(payload, '4x3_standard');
    expect(countPdfPages(pdf)).toBe(1);
    expect(validateLabelPdfSize(pdf, '4x3_standard', 0.6).ok).toBe(true);
  });

  test('barcode PNG generation succeeds', async () => {
    const png = await renderCode128BarcodePng(payload.barcodeValue, BARCODE.heightMm);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  test('legacy profile aliases still validate old queued jobs (no rotated/landscape profile)', async () => {
    const legacyPayload = parseLabelPayload({ ...payload, labelProfile: '4x3_landscape' });
    const pdf = await renderOnlineOrderLabel(legacyPayload, '4x3_landscape');
    const result = validateLabelPdfSize(pdf, '4x3_landscape', 0.6);

    expect(legacyPayload.labelProfile).toBe('4x3_standard');
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('4x3_standard');
    expect(result.rotation).toBe(0);
  });
});
