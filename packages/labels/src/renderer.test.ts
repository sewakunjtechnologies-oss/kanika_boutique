import { describe, expect, test } from 'vitest';
import { LabelPayload, parseLabelPayload } from './payload';
import { LABEL_PROFILES, getContentBox, mmToPt } from './profiles';
import { computeLabelLayout, renderCode128BarcodePng, renderOrderLabel } from './renderer';
import { countPdfPages, validateLabelPdfSize } from './validate';

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

describe('label PDF renderer', () => {
  test('4x3_standard PDF is exactly 101.6 x 76.2 mm with no rotation', async () => {
    const pdf = await renderOrderLabel(payload, '4x3_standard');
    const result = validateLabelPdfSize(pdf, '4x3_standard', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
    expect(result.actual!.widthPt).toBeGreaterThan(result.actual!.heightPt);
    expect(result.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(LABEL_PROFILES['4x3_standard'].orientation).toBe('portrait');
    expect(LABEL_PROFILES['4x3_standard'].rendererRotation).toBe(0);
    expect(LABEL_PROFILES['4x3_standard'].rotation).toBe(0);
  });

  test('4x3_standard content box is centered at 96 x 68 mm', () => {
    const box = getContentBox('4x3_standard');
    const layout = computeLabelLayout(payload, '4x3_standard');

    expect(box.widthMm).toBe(96);
    expect(box.heightMm).toBe(68);
    expect(box.offsetXmm).toBeCloseTo(2.8, 5);
    expect(box.offsetYmm).toBeCloseTo(4.1, 5);
    expect(layout.pageWidthPt).toBeCloseTo(mmToPt(96), 0);
    expect(layout.pageHeightPt).toBeCloseTo(mmToPt(68), 0);
    expect(layout.contentOffsetXPt).toBeCloseTo(mmToPt(2.8), 0);
    expect(layout.contentOffsetYPt).toBeCloseTo(mmToPt(4.1), 0);
    expect(layout.overflows).toBe(false);
    expect(layout.bodyBottomPt).toBeLessThan(layout.barcodeAreaTopPt);
    expect(layout.barcodeBottomPt).toBeLessThan(layout.barcodeAreaBottomPt);
    expect(layout.barcodeAreaBottomPt).toBeLessThanOrEqual(layout.physicalBottomSafePt + 0.5);
  });

  test('long names do not change page count', async () => {
    const pdf = await renderOrderLabel(payload, '4x3_standard');

    expect(countPdfPages(pdf)).toBe(1);
  });

  test('long address truncates without overflow or extra pages', async () => {
    const longAddressPayload = parseLabelPayload({
      ...payload,
      addressLine1: 'Very long house number and tower name that should truncate cleanly',
      addressLine2: 'Near a very long landmark and market road that should not overlap product data',
      city: 'Sonipat With Long Locality Name',
      state: 'Haryana',
    });
    const layout = computeLabelLayout(longAddressPayload, '4x3_standard');
    const pdf = await renderOrderLabel(longAddressPayload, '4x3_standard');

    expect(layout.overflows).toBe(false);
    expect(countPdfPages(pdf)).toBe(1);
    expect(validateLabelPdfSize(pdf, '4x3_standard', 0.6).ok).toBe(true);
  });

  test('barcode PNG generation succeeds', async () => {
    const png = await renderCode128BarcodePng(payload.barcodeValue, LABEL_PROFILES['4x3_standard'].barcodeHeightMm);

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  test('legacy profile aliases still validate old queued jobs', async () => {
    const legacyPayload = parseLabelPayload({ ...payload, labelProfile: '4x3_landscape' });
    const pdf = await renderOrderLabel(legacyPayload, '4x3_landscape');
    const result = validateLabelPdfSize(pdf, '4x3_landscape', 0.6);

    expect(legacyPayload.labelProfile).toBe('4x3_standard');
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('4x3_standard');
    expect(result.rotation).toBe(0);
  });
});
