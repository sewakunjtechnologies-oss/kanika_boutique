import { describe, expect, test } from 'vitest';
import { TESTED_LABEL_CSS_4X3 } from './renderer';
import {
  parseOfflineCustomerSlipPayload,
  renderManualReceipt,
  renderManualReceiptHtml,
  renderOfflineCustomerSlip,
} from './offlineCustomerSlip';

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
});

describe('manual receipt HTML renderer', () => {
  test('uses the exact tested 4x3 CSS and receipt body', async () => {
    const html = await renderManualReceiptHtml(payload, '4x3');
    expect(html).toContain(TESTED_LABEL_CSS_4X3);
    expect(html).toContain('<div class="paid">RECEIPT</div>');
    expect(html).toContain('Receipt ID: MR-2026-0001');
    expect(html).toContain('<strong>Customer:</strong> test-1');
    expect(html).toContain('<strong>Phone:</strong> 74XXXXXX41');
    expect(html).toContain('<strong>Payment:</strong> CASH');
    expect(html).toContain('<strong>Product:</strong> Three-piece Kurti');
    expect(html).toContain('<strong>SKU:</strong> three-piece-kurtis-mq6b1e77');
    expect(html).toContain('<strong>Size:</strong> 38');
    expect(html).toContain('<strong>Quantity:</strong> 1');
    expect(html).toContain('Amount: ₹1860');
    expect(html).toContain('<div class="barcode-text">MR-2026-0001</div>');
  });

  test('manual receipt contains no address, pincode, courier or shipping rows', async () => {
    const html = await renderManualReceiptHtml(payload, '4x3');
    expect(html).not.toContain('<strong>Address:</strong>');
    expect(html).not.toContain('<strong>Pincode:</strong>');
    expect(html).not.toContain('<strong>City:</strong>');
    expect(html).not.toContain('<strong>State:</strong>');
    expect(html).not.toContain('courier');
    expect(html).not.toContain('shipping');
  });

  test('manual receipt schema strips address-like fields instead of rendering them', () => {
    const parsed = parseOfflineCustomerSlipPayload({
      ...payload,
      addressLine1: 'Should not exist',
      addressLine2: 'Should not exist',
      city: 'Should not exist',
      state: 'Should not exist',
      pincode: '000000',
      courier: 'Should not exist',
    });

    expect('addressLine1' in parsed).toBe(false);
    expect('addressLine2' in parsed).toBe(false);
    expect('city' in parsed).toBe(false);
    expect('state' in parsed).toBe(false);
    expect('pincode' in parsed).toBe(false);
    expect('courier' in parsed).toBe(false);
  });

  test('manual receipt aliases return the same HTML template', async () => {
    const html = await renderManualReceiptHtml(payload, '4x3');
    await expect(renderManualReceipt(payload, '4x3')).resolves.toBe(html);
    await expect(renderOfflineCustomerSlip(payload, '4x3')).resolves.toBe(html);
  });

  test('multiple items are summarized without adding a second template body', async () => {
    const html = await renderManualReceiptHtml(
      {
        ...payload,
        items: [
          payload.items[0]!,
          {
            name: 'Second Item',
            sku: 'SKU-2',
            size: '42',
            quantity: 2,
            unitPrice: 500,
            amount: 1000,
          },
        ],
      },
      '4x3',
    );

    expect(html).toContain('Three-piece Kurti +1 more');
    expect(html).toContain('<strong>Quantity:</strong> 3');
    expect(html.match(/<main class="label">/g)).toHaveLength(1);
  });
});
