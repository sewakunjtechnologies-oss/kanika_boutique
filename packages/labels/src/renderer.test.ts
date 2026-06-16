import { describe, expect, test } from 'vitest';
import { LabelPayload } from './payload';
import { LABEL_PROFILES, mmToPt } from './profiles';
import { computeLabelLayout, renderCode128BarcodePng, renderOrderLabel } from './renderer';
import { countPdfPages, validateLabelPdfSize } from './validate';

const payload: LabelPayload = {
  storeName: 'Kanika Designs',
  orderId: 'KDA-2026-000123',
  customerName: 'Customer With A Very Very Long Name That Must Not Wrap',
  maskedPhone: '98XXXXXX21',
  productName: 'Blue Floral Pure Cotton Suit With Dupatta And Very Long Product Name',
  sku: 'ARTICLE-1-BLUE-FLORAL',
  size: '40',
  quantity: 2,
  amount: 4540,
  paymentStatus: 'PAID',
  paymentType: 'UPI',
  barcodeValue: 'KDA-2026-000123',
  addressLine: 'Long address line for 4x4 only, should not disturb 4x3 core layout',
  pincode: '110001',
  labelProfile: '4x3',
};

describe('label PDF renderer', () => {
  test('4x3 PDF is exactly 101.6 x 76.2 mm', async () => {
    const pdf = await renderOrderLabel(payload, '4x3');
    const result = validateLabelPdfSize(pdf, '4x3', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
  });

  test('4x4 PDF is exactly 101.6 x 101.6 mm', async () => {
    const pdf = await renderOrderLabel({ ...payload, labelProfile: '4x4' }, '4x4');
    const result = validateLabelPdfSize(pdf, '4x4', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(101.6), 0);
  });

  test('4x3 content stays inside safe box and barcode stays above bottom margin', () => {
    const layout = computeLabelLayout(payload, '4x3');

    expect(layout.overflows).toBe(false);
    expect(layout.coreBottomPt).toBeLessThan(layout.barcodeAreaTopPt);
    expect(layout.barcodeBottomPt).toBeLessThan(layout.barcodeAreaBottomPt);
    expect(layout.barcodeAreaBottomPt).toBeLessThanOrEqual(layout.physicalBottomSafePt + 0.5);
    expect(layout.pageHeightPt - layout.barcodeAreaBottomPt).toBeGreaterThanOrEqual(
      mmToPt(LABEL_PROFILES['4x3'].marginBottomMm) - 0.5,
    );
  });

  test('long names do not change page count', async () => {
    const pdf = await renderOrderLabel(payload, '4x3');

    expect(countPdfPages(pdf)).toBe(1);
  });

  test('barcode PNG generation succeeds', async () => {
    const png = await renderCode128BarcodePng(payload.barcodeValue, LABEL_PROFILES['4x3'].barcodeHeightMm);

    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
