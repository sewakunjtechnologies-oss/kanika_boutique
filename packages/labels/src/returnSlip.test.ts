import { describe, expect, test } from 'vitest';
import { TESTED_LABEL_CSS_4X3 } from './renderer';
import { parseManualReceiptReturnSlipPayload, renderManualReceiptReturnSlipHtml } from './returnSlip';

const payload = parseManualReceiptReturnSlipPayload({
  templateVersion: 'manual-return-slip-v1',
  storeName: 'KANIKA DESIGNS',
  receiptId: 'MR-2026-0001',
  returnId: 'ret_123',
  customerName: 'Priya Sharma',
  phoneMasked: '98XXXXXX21',
  createdAt: '2026-06-17T10:09:00.000Z',
  refundMethod: 'CASH',
  refundAmount: 1000,
  reason: 'Customer returned item',
  items: [{ name: 'Kurti', sku: 'SKU1', size: '38', quantity: 1, refundAmount: 1000 }],
  barcodeValue: 'ret_123',
});

describe('manual receipt return slip renderer', () => {
  test('uses the tested 4x3 CSS and return body', async () => {
    const html = await renderManualReceiptReturnSlipHtml(payload, '4x3');

    expect(html).toContain(TESTED_LABEL_CSS_4X3);
    expect(html).toContain('<div class="paid">RETURN</div>');
    expect(html).toContain('Return ID: ret_123');
    expect(html).toContain('<strong>Receipt:</strong> MR-2026-0001');
    expect(html).toContain('<strong>Customer:</strong> Priya Sharma');
    expect(html).toContain('<strong>Refund:</strong> CASH');
    expect(html).toContain('Refund: ₹1000');
    expect(html).toContain('<div class="barcode-text">ret_123</div>');
  });

  test('return slip contains no address or pincode fields', async () => {
    const html = await renderManualReceiptReturnSlipHtml(payload, '4x3');

    expect(html).not.toContain('<strong>Address:</strong>');
    expect(html).not.toContain('<strong>Pincode:</strong>');
    expect(html).not.toContain('courier');
  });
});
