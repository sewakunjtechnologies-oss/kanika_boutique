import { describe, expect, test } from 'vitest';
import { LabelPayload, parseLabelPayload } from './payload';
import { LABEL_PROFILES, mmToPt } from './profiles';
import { computeLabelLayout, renderCode128BarcodePng, renderOrderLabel } from './renderer';
import { countPdfPages, validateLabelPdfSize } from './validate';

const payload: LabelPayload = {
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
  labelProfile: '4x3',
};

describe('label PDF renderer', () => {
  test('4x3 PDF is exactly 101.6 x 76.2 mm with no rotation', async () => {
    const pdf = await renderOrderLabel(payload, '4x3');
    const result = validateLabelPdfSize(pdf, '4x3', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
    expect(result.actual!.widthPt).toBeGreaterThan(result.actual!.heightPt);
    expect(result.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(LABEL_PROFILES['4x3'].orientation).toBe('portrait');
    expect(LABEL_PROFILES['4x3'].rotation).toBe(0);
  });

  test('4x4_portrait PDF is exactly 101.6 x 101.6 mm and portrait profile', async () => {
    const pdf = await renderOrderLabel({ ...payload, labelProfile: '4x4_portrait' }, '4x4_portrait');
    const result = validateLabelPdfSize(pdf, '4x4_portrait', 0.6);

    expect(result.ok).toBe(true);
    expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(result.actual?.heightPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(LABEL_PROFILES['4x4_portrait'].orientation).toBe('portrait');
  });

  test('4x3 content stays inside safe box and barcode stays above bottom margin', () => {
    const layout = computeLabelLayout(payload, '4x3');

    expect(layout.overflows).toBe(false);
    expect(layout.bodyBottomPt).toBeLessThan(layout.barcodeAreaTopPt);
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

  describe('4x3_portrait_rotated', () => {
    const rotated: LabelPayload = { ...payload, labelProfile: '4x3_portrait_rotated' };

    test('1+2+7. PDF page is exactly 101.6 x 76.2 mm, /Rotate 0, single page', async () => {
      const pdf = await renderOrderLabel(rotated, '4x3_portrait_rotated');
      const result = validateLabelPdfSize(pdf, '4x3_portrait_rotated', 0.6);

      expect(result.ok).toBe(true);
      expect(result.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
      expect(result.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
      // Physical page is landscape (wider than tall).
      expect(result.actual!.widthPt).toBeGreaterThan(result.actual!.heightPt);
      expect(result.rotation).toBe(0);
      expect(countPdfPages(pdf)).toBe(1);
    });

    test('3+4. logical canvas is portrait and the renderer rotates it 90 degrees', () => {
      const profile = LABEL_PROFILES['4x3_portrait_rotated'];
      const layout = computeLabelLayout(rotated, '4x3_portrait_rotated');

      // Logical design canvas is portrait (taller than wide)...
      expect(profile.designHeightMm).toBeGreaterThan(profile.designWidthMm);
      expect(layout.pageHeightPt).toBeGreaterThan(layout.pageWidthPt);
      // ...while the physical page is landscape, and metadata rotation stays 0.
      expect(layout.physicalWidthPt).toBeGreaterThan(layout.physicalHeightPt);
      expect(profile.rotation).toBe(0);
      // The single rotation layer lives in the renderer.
      expect(profile.rendererRotation).toBe(90);
    });

    test('5+6. content stays inside the logical canvas and barcode stays in bounds', () => {
      const layout = computeLabelLayout(rotated, '4x3_portrait_rotated');

      expect(layout.overflows).toBe(false);
      expect(layout.bodyBottomPt).toBeLessThan(layout.barcodeAreaTopPt);
      expect(layout.barcodeBottomPt).toBeLessThan(layout.barcodeAreaBottomPt);
      expect(layout.barcodeAreaBottomPt).toBeLessThanOrEqual(layout.physicalBottomSafePt + 0.5);
      // Safe area fits within the logical canvas width.
      expect(layout.safeXPt + layout.safeWidthPt).toBeLessThanOrEqual(
        layout.pageWidthPt - mmToPt(LABEL_PROFILES['4x3_portrait_rotated'].marginRightMm) + 0.5,
      );
    });

    test('8. a long address still produces exactly one page', async () => {
      const longAddress: LabelPayload = {
        ...rotated,
        addressLine1: 'House No. 1234, Third Floor, Above State Bank Of India Branch',
        addressLine2: 'Opposite The Very Large And Famous Community Market Gate Number Seven',
        city: 'Greater Noida West Extension Township',
        state: 'Uttar Pradesh',
        pincode: '201318',
      };
      const pdf = await renderOrderLabel(longAddress, '4x3_portrait_rotated');

      expect(countPdfPages(pdf)).toBe(1);
      expect(validateLabelPdfSize(pdf, '4x3_portrait_rotated', 0.6).ok).toBe(true);
    });

    test('a long product name still produces exactly one page', async () => {
      const longProduct: LabelPayload = {
        ...rotated,
        productName:
          'Premium Hand Embroidered Pure Banarasi Silk Anarkali Suit Set With Heavy Dupatta And Matching Bottom Extra Long Title',
        sku: 'KD-PREMIUM-BANARASI-ANARKALI-XXL-EDITION-0001',
      };
      const pdf = await renderOrderLabel(longProduct, '4x3_portrait_rotated');

      expect(countPdfPages(pdf)).toBe(1);
      expect(validateLabelPdfSize(pdf, '4x3_portrait_rotated', 0.6).ok).toBe(true);
    });
  });

  test('legacy profile aliases still validate old queued jobs', async () => {
    const legacyPayload = parseLabelPayload({ ...payload, labelProfile: '4x3_landscape' });
    const pdf = await renderOrderLabel(legacyPayload, '4x3_landscape');
    const result = validateLabelPdfSize(pdf, '4x3_landscape', 0.6);

    expect(legacyPayload.labelProfile).toBe('4x3');
    expect(result.ok).toBe(true);
    expect(result.profile).toBe('4x3');
    expect(result.rotation).toBe(0);
  });
});
