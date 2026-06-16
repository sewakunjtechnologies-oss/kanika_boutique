import fs from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';

describe('print bridge dry run', () => {
  test('writes an exact-size PDF without sending to printer', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.LABEL_PROFILE = '4x3';
    process.env.PRINT_DRY_RUN = 'true';
    process.env.OUTPUT_DIR = './tmp-test-output';
    vi.resetModules();

    const { renderJobPdf } = await import('./printer');
    const { validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf({
      id: 'dry-run-job',
      type: 'TEST_LABEL',
      status: 'CLAIMED',
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: {
        storeName: 'Kanika Designs',
        orderId: 'DRY-RUN',
        customerName: 'Test Customer',
        maskedPhone: '98XXXXXX21',
        pincode: '110001',
        productName: 'Blue Floral Pure Cotton Suit',
        sku: 'ARTICLE-1',
        size: '40',
        quantity: 1,
        paymentType: 'UPI',
        paymentStatus: 'PAID',
        amount: 2270,
        barcodeValue: 'DRY-RUN',
        addressLine: '',
        labelProfile: '4x3',
      },
    });

    const pdf = await fs.readFile(filePath);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(validateLabelPdfSize(pdf, '4x3', 0.6).ok).toBe(true);
  });
});
