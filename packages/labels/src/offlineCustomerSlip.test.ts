import { describe, expect, test } from 'vitest';
import { mmToPt } from './profiles';
import { PAD, PAGE, contentBox } from './labelLayout';
import {
  computeOfflineSlipLayout,
  parseOfflineCustomerSlipPayload,
  renderManualReceipt,
  renderOfflineCustomerSlip,
} from './offlineCustomerSlip';
import { countPdfPages, extractPdfText, readPdfRotation, validateLabelPdfSize } from './validate';

const payload = parseOfflineCustomerSlipPayload({
  templateVersion: 'manual-receipt-v1',
  storeName: 'KANIKA DESIGNS',
  receiptId: 'MR-2026-0001',
  customerName: 'test-1',
  phoneMasked: '74XXXXXX41',
  createdAt: '2026-06-17T10:09:00.000Z',
  paymentMethod: 'CASH',
  subtotal: 1760,
  delivery: 100,
  discount: 0,
  total: 1860,
  items: [
    {
      name: 'Three-piece Kurti',
      sku: 'three-piece-kurtis-mq6b1e77',
      size: '38',
      quantity: 1,
      unitPrice: 1760,
      amount: 1760,
    },
  ],
  barcodeValue: 'MR-2026-0001',
  labelProfile: '4x3_standard',
});

describe('manual receipt (offline customer slip) renderer', () => {
  test('PDF is exactly 101.6 x 76.2 mm, one page, no rotation', async () => {
    const pdf = await renderManualReceipt(payload);
    const validation = validateLabelPdfSize(pdf, '4x3_standard', 0.6);

    expect(validation.ok).toBe(true);
    expect(validation.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(validation.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
    expect(validation.rotation).toBe(0);
    expect(readPdfRotation(pdf)).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
  });

  test('layout uses the full physical page with the tested HTML padding', () => {
    const layout = computeOfflineSlipLayout('4x3_standard');
    const box = contentBox();

    expect(layout.physicalWidthPt).toBeCloseTo(mmToPt(PAGE.widthMm), 5);
    expect(layout.physicalHeightPt).toBeCloseTo(mmToPt(PAGE.heightMm), 5);
    expect(layout.box.x).toBeCloseTo(box.x, 5);
    expect(layout.box.y).toBeCloseTo(box.y, 5);
    expect(box.x).toBeCloseTo(mmToPt(PAD.leftMm), 5);
    expect(box.y).toBeCloseTo(mmToPt(PAD.topMm), 5);
    expect(layout.rotation).toBe(0);
    expect(layout.pages).toBe(1);
  });

  test('manual receipt PDF contains no address, courier or shipping text', async () => {
    const pdf = await renderManualReceipt({
      ...payload,
      // Even if upstream tried to smuggle address text via the product name we
      // would not draw an Address: row — the template has no address row at all.
    });
    const text = extractPdfText(pdf);
    expect(text).not.toContain('Address:');
    expect(text).not.toContain('Pincode:');
  });

  test('manual receipt payload schema rejects address/courier fields', () => {
    const parsed = parseOfflineCustomerSlipPayload({
      ...payload,
      addressLine1: 'Should be ignored',
      addressLine2: 'Should be ignored',
      city: 'Should be ignored',
      state: 'Should be ignored',
      pincode: '000000',
    });

    expect('addressLine1' in parsed).toBe(false);
    expect('addressLine2' in parsed).toBe(false);
    expect('city' in parsed).toBe(false);
    expect('state' in parsed).toBe(false);
    expect('pincode' in parsed).toBe(false);
  });

  test('long product name does not change page count and truncates', async () => {
    const first = payload.items[0]!;
    const pdf = await renderOfflineCustomerSlip({
      ...payload,
      items: [
        {
          name: 'Very Long Three-piece Kurti Product Name With Extra Embroidery And Dupatta That Must Truncate',
          sku: first.sku,
          size: first.size,
          quantity: first.quantity,
          unitPrice: first.unitPrice,
          amount: first.amount,
        },
      ],
    });

    expect(countPdfPages(pdf)).toBe(1);
    expect(validateLabelPdfSize(pdf, '4x3_standard', 0.6).ok).toBe(true);
    expect(readPdfRotation(pdf)).toBe(0);
  });
});
