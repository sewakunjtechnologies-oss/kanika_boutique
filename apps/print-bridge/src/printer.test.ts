import fs from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';

describe('print bridge dry run', () => {
  test('writes an exact-size PDF without sending to printer', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.PRINT_JOB_BATCH_SIZE = '1';
    process.env.LABEL_PROFILE = '4x3_standard';
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
        templateVersion: 'test-label-v1',
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
        labelProfile: '4x3_standard',
      },
    });

    const pdf = await fs.readFile(filePath);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const validation = validateLabelPdfSize(pdf, '4x3_standard', 0.6);
    expect(validation.ok).toBe(true);
    expect(validation.actual!.widthPt).toBeGreaterThan(validation.actual!.heightPt);
    expect(validation.rotation).toBe(0);
  });

  test('recognizes OFFLINE_CUSTOMER_SLIP and renders an exact-size PDF', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.PRINT_JOB_BATCH_SIZE = '1';
    process.env.LABEL_PROFILE = '4x3_standard';
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
      },
    });

    const pdf = await fs.readFile(filePath);
    const validation = validateLabelPdfSize(pdf, '4x3_standard', 0.6);
    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
  });

  test('dispatch maps each job type to its dedicated template and renderer', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.LABEL_PROFILE = '4x3_standard';
    process.env.PRINT_DRY_RUN = 'true';
    vi.resetModules();

    const { dispatchForJobType } = await import('./printer');
    expect(dispatchForJobType('OFFLINE_CUSTOMER_SLIP')).toEqual({
      requestedTemplate: 'manual-receipt',
      renderer: 'renderManualReceipt',
    });
    expect(dispatchForJobType('ORDER_LABEL')).toEqual({
      requestedTemplate: 'online-order-label',
      renderer: 'renderOnlineOrderLabel',
    });
    expect(dispatchForJobType('TEST_LABEL')).toEqual({
      requestedTemplate: 'test-label',
      renderer: 'renderTestLabel',
    });
  });

  test('manual receipt and online label use different renderer functions and bodies', async () => {
    const { renderManualReceipt, renderOnlineOrderLabel } = await import('@kda/labels');
    // Distinct functions — they share CSS/geometry, not a body template.
    expect(renderManualReceipt).not.toBe(renderOnlineOrderLabel);

    const manual = await renderManualReceipt({
      templateVersion: 'manual-receipt-v1',
      storeName: 'KANIKA DESIGNS',
      receiptId: 'MR-2026-0002',
      customerName: 'Walk-in',
      phoneMasked: '74XXXXXX41',
      createdAt: '2026-06-17T10:09:00.000Z',
      paymentMethod: 'CASH',
      subtotal: 1000,
      delivery: 0,
      discount: 0,
      total: 1000,
      items: [{ name: 'Kurti', sku: 'SKU1', size: '38', quantity: 1, unitPrice: 1000, amount: 1000 }],
      barcodeValue: 'MR-2026-0002',
      labelProfile: '4x3_standard',
    });
    const online = await renderOnlineOrderLabel({
      templateVersion: 'online-order-label-v1',
      storeName: 'KANIKA DESIGNS',
      orderId: 'KD-2',
      customerName: 'Walk-in',
      maskedPhone: '74XXXXXX41',
      phoneMasked: '74XXXXXX41',
      productName: 'Kurti',
      sku: 'SKU1',
      size: '38',
      quantity: 1,
      amount: 1000,
      paymentStatus: 'PAID',
      paymentType: 'UPI',
      barcodeValue: 'KD-2',
      addressLine: 'H.No 1',
      addressLine1: 'H.No 1',
      addressLine2: '',
      city: 'Sonipat',
      state: 'Haryana',
      pincode: '131001',
      labelProfile: '4x3_standard',
    });

    const { extractPdfText } = await import('@kda/labels');
    expect(extractPdfText(manual)).not.toContain('Address:');
    expect(extractPdfText(online)).toContain('Address:');
    expect(extractPdfText(online)).toContain('Pincode:');
  });

  test('rejects old pending test labels without the current template version', async () => {
    process.env.BACKEND_URL = 'https://kanika-boutique.onrender.com';
    process.env.PRINT_AGENT_TOKEN = 'test_print_agent_token_value_32_chars';
    process.env.DEVICE_ID = 'test-device';
    process.env.PRINTER_NAME = '4BARCODE 4B-2054TG';
    process.env.PRINT_JOB_BATCH_SIZE = '1';
    process.env.LABEL_PROFILE = '4x3_standard';
    process.env.LABEL_WIDTH_MM = '101.6';
    process.env.LABEL_HEIGHT_MM = '76.2';
    process.env.PRINT_ORIENTATION = 'portrait';
    process.env.PRINT_ROTATION = '0';
    process.env.PRINT_SCALE_MODE = 'noscale';
    process.env.PRINT_DRY_RUN = 'true';
    process.env.OUTPUT_DIR = './tmp-test-output';
    vi.resetModules();

    const { renderJobPdf } = await import('./printer');
    await expect(renderJobPdf({
      id: 'old-test-label',
      type: 'TEST_LABEL',
      status: 'CLAIMED',
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: {
        storeName: 'Kanika Designs',
        orderId: 'OLD-TEST',
        barcodeValue: 'OLD-TEST',
      },
    })).rejects.toThrow();
  });
});
