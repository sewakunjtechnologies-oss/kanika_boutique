import { describe, expect, test } from 'vitest';
import { getContentBox, mmToPt } from './profiles';
import {
  computeOfflineSlipLayout,
  parseOfflineCustomerSlipPayload,
  renderOfflineCustomerSlip,
} from './offlineCustomerSlip';
import { countPdfPages, validateLabelPdfSize } from './validate';

const payload = parseOfflineCustomerSlipPayload({
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
  labelProfile: 'compact_96x68',
});

describe('offline customer slip renderer', () => {
  test('manual slip PDF is exactly 101.6 x 76.2 mm with one page and no rotation', async () => {
    const pdf = await renderOfflineCustomerSlip(payload);
    const validation = validateLabelPdfSize(pdf, 'compact_96x68', 0.6);

    expect(validation.ok).toBe(true);
    expect(validation.actual?.widthPt).toBeCloseTo(mmToPt(101.6), 0);
    expect(validation.actual?.heightPt).toBeCloseTo(mmToPt(76.2), 0);
    expect(validation.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
  });

  test('content box is exactly 96 x 68 mm and centered', () => {
    const box = getContentBox('compact_96x68');
    const layout = computeOfflineSlipLayout('compact_96x68');

    expect(box.widthMm).toBe(96);
    expect(box.heightMm).toBe(68);
    expect(box.offsetXmm).toBeCloseTo(2.8, 5);
    expect(box.offsetYmm).toBeCloseTo(4.1, 5);
    expect(layout.contentWidthPt).toBeCloseTo(mmToPt(96), 0);
    expect(layout.contentHeightPt).toBeCloseTo(mmToPt(68), 0);
    expect(layout.contentOffsetXPt).toBeCloseTo(mmToPt(2.8), 0);
    expect(layout.contentOffsetYPt).toBeCloseTo(mmToPt(4.1), 0);
  });

  test('long product name does not change page count', async () => {
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
    expect(validateLabelPdfSize(pdf, 'compact_96x68', 0.6).ok).toBe(true);
  });
});
