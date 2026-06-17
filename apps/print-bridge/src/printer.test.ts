import fs from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';

describe('print bridge dry run', () => {
  test('writes an exact-size PDF without sending to printer', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.LABEL_PROFILE = 'compact_96x68';
    process.env.LABEL_WIDTH_MM = '101.6';
    process.env.LABEL_HEIGHT_MM = '76.2';
    process.env.PRINT_ORIENTATION = 'portrait';
    process.env.PRINT_ROTATION = '0';
    process.env.PRINT_SCALE_MODE = 'noscale';
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
        phoneMasked: '98XXXXXX21',
        addressLine1: 'H.No. 25, Sector 14',
        addressLine2: 'Near Main Market',
        city: 'Sonipat',
        state: 'Haryana',
        pincode: '110001',
        productName: 'Blue Floral Pure Cotton Suit',
        sku: 'ARTICLE-1',
        size: '40',
        quantity: 1,
        paymentType: 'UPI',
        paymentStatus: 'PAID',
        amount: 2270,
        barcodeValue: 'DRY-RUN',
        labelProfile: 'compact_96x68',
      },
    });

    const pdf = await fs.readFile(filePath);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const validation = validateLabelPdfSize(pdf, 'compact_96x68', 0.6);
    expect(validation.ok).toBe(true);
    expect(validation.actual!.widthPt).toBeGreaterThan(validation.actual!.heightPt);
    expect(validation.rotation).toBe(0);
  });

  test('recognizes OFFLINE_CUSTOMER_SLIP and renders an exact-size PDF', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.LABEL_PROFILE = 'compact_96x68';
    process.env.LABEL_WIDTH_MM = '101.6';
    process.env.LABEL_HEIGHT_MM = '76.2';
    process.env.PRINT_ORIENTATION = 'portrait';
    process.env.PRINT_ROTATION = '0';
    process.env.PRINT_SCALE_MODE = 'noscale';
    process.env.PRINT_DRY_RUN = 'true';
    process.env.OUTPUT_DIR = './tmp-test-output';
    vi.resetModules();

    const { renderJobPdf } = await import('./printer');
    const { validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf({
      id: 'offline-slip-job',
      type: 'OFFLINE_CUSTOMER_SLIP',
      status: 'CLAIMED',
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: {
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
      },
    });

    const pdf = await fs.readFile(filePath);
    const validation = validateLabelPdfSize(pdf, 'compact_96x68', 0.6);
    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
  });
});
