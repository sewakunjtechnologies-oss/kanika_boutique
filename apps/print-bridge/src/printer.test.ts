import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('./printing/electronHtmlPrinter', async (importActual) => {
  const actual = await importActual<typeof import('./printing/electronHtmlPrinter')>();
  return {
    ...actual,
    printHtmlToWindowsPrinter: vi.fn().mockResolvedValue(undefined),
    listElectronPrinters: vi.fn().mockResolvedValue([{ name: '4BARCODE 4B-2054TG', isDefault: true }]),
  };
});

const outputDir = './tmp-test-output';

beforeEach(async () => {
  await fs.rm(path.resolve(process.cwd(), outputDir), { recursive: true, force: true });
  vi.resetModules();
});

afterEach(async () => {
  await fs.rm(path.resolve(process.cwd(), outputDir), { recursive: true, force: true });
});

describe('print bridge HTML renderer', () => {
  test('writes a 4x3 exact-size PDF preview from the online order HTML template', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3' });

    const { renderJobPdf } = await import('./printer');
    const { countPdfPages, validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf(onlineOrderJob('online-4x3'));

    const pdf = await fs.readFile(filePath);
    const html = await fs.readFile(filePath.replace(/\.pdf$/, '.html'), 'utf8');
    const validation = validateLabelPdfSize(pdf, '4x3', 0.6);

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(html).toContain('@page {\n  size: 101.6mm 76.2mm;\n  margin: 0;\n}');
    expect(html).toContain('<strong>Address:</strong> H.No. 25, Sector 14, Near Main Market, Sonipat, Haryana');
    expect(html).toContain('<strong>Pincode:</strong> 131001');
  });

  test('writes a 4x4 exact-size PDF preview without changing template body or print settings', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x4' });

    const { renderJobPdf } = await import('./printer');
    const { countPdfPages, validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf(onlineOrderJob('online-4x4'));

    const pdf = await fs.readFile(filePath);
    const html = await fs.readFile(filePath.replace(/\.pdf$/, '.html'), 'utf8');
    const validation = validateLabelPdfSize(pdf, '4x4', 0.6);

    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(html).toContain('@page {\n  size: 101.6mm 101.6mm;\n  margin: 0;\n}');
    expect(html).toContain('width: 86mm;');
    expect(html).toContain('height: 9mm;');
  });

  test('manual receipt renders as OFFLINE_CUSTOMER_SLIP and contains no address rows', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3' });

    const { renderJobPdf } = await import('./printer');
    const { countPdfPages, validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf(manualReceiptJob('manual-4x3'));

    const pdf = await fs.readFile(filePath);
    const html = await fs.readFile(filePath.replace(/\.pdf$/, '.html'), 'utf8');
    const validation = validateLabelPdfSize(pdf, '4x3', 0.6);

    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(html).toContain('<div class="paid">RECEIPT</div>');
    expect(html).toContain('Receipt ID: MR-2026-0001');
    expect(html).not.toContain('<strong>Address:</strong>');
    expect(html).not.toContain('<strong>Pincode:</strong>');
    expect(html).not.toContain('courier');
  });

  test('manual return slip renders as OFFLINE_RETURN_SLIP without address rows', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3' });

    const { renderJobPdf } = await import('./printer');
    const { countPdfPages, validateLabelPdfSize } = await import('@kda/labels');
    const filePath = await renderJobPdf(manualReturnSlipJob('return-4x3'));

    const pdf = await fs.readFile(filePath);
    const html = await fs.readFile(filePath.replace(/\.pdf$/, '.html'), 'utf8');
    const validation = validateLabelPdfSize(pdf, '4x3', 0.6);

    expect(validation.ok).toBe(true);
    expect(validation.rotation).toBe(0);
    expect(countPdfPages(pdf)).toBe(1);
    expect(html).toContain('<div class="paid">RETURN</div>');
    expect(html).toContain('Return ID: RET-2026-0001');
    expect(html).not.toContain('<strong>Address:</strong>');
    expect(html).not.toContain('<strong>Pincode:</strong>');
  });

  test('dispatch maps job types to dedicated HTML renderers', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3' });

    const { dispatchForJobType } = await import('./printer');
    expect(dispatchForJobType('OFFLINE_CUSTOMER_SLIP')).toEqual({
      requestedTemplate: 'manual-receipt',
      renderer: 'renderManualReceiptHtml',
    });
    expect(dispatchForJobType('OFFLINE_RETURN_SLIP')).toEqual({
      requestedTemplate: 'manual-return-slip',
      renderer: 'renderManualReceiptReturnSlipHtml',
    });
    expect(dispatchForJobType('ORDER_LABEL')).toEqual({
      requestedTemplate: 'online-order-label',
      renderer: 'renderOnlineOrderHtml',
    });
    expect(dispatchForJobType('TEST_LABEL')).toEqual({
      requestedTemplate: 'test-label',
      renderer: 'renderTestLabel',
    });
    expect(() => dispatchForJobType('PRODUCT_BARCODE')).toThrow('unsupported print job type');
  });

  test('old geometry environment variables are ignored', async () => {
    setBridgeEnv({
      LABEL_SIZE: '4x3',
      LABEL_PROFILE: 'rotated-old-profile',
      LABEL_WIDTH_MM: '1',
      LABEL_HEIGHT_MM: '1',
      CONTENT_WIDTH_MM: '1',
      CONTENT_HEIGHT_MM: '1',
      CONTENT_OFFSET_X_MM: '99',
      CONTENT_OFFSET_Y_MM: '99',
      RENDER_ROTATION: '90',
      PDF_ROTATION: '90',
      PRINT_ORIENTATION: 'landscape',
      PRINT_ROTATION: '90',
      PRINT_SCALE_MODE: 'fit',
      PRINT_AUTO_ROTATE: 'true',
      PRINT_FIT_TO_PAGE: 'true',
      DESIGN_WIDTH_MM: '1',
      DESIGN_HEIGHT_MM: '1',
    });

    const { bridgeEnv } = await import('./config');
    const { renderJobPdf } = await import('./printer');
    const { validateLabelPdfSize } = await import('@kda/labels');

    expect('LABEL_PROFILE' in bridgeEnv).toBe(false);
    expect('LABEL_WIDTH_MM' in bridgeEnv).toBe(false);
    expect('PRINT_ORIENTATION' in bridgeEnv).toBe(false);
    expect('PRINT_SCALE_MODE' in bridgeEnv).toBe(false);

    const filePath = await renderJobPdf(onlineOrderJob('ignored-old-vars'));
    const pdf = await fs.readFile(filePath);
    expect(validateLabelPdfSize(pdf, '4x3', 0.6).ok).toBe(true);
  });

  test('Windows print invocation uses Electron HTML printing, not PDF shell printing', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3', PRINT_DRY_RUN: 'false' });

    const electronPrinter = await import('./printing/electronHtmlPrinter');
    const { printJobHtml } = await import('./printer');
    await printJobHtml(manualReceiptJob('manual-electron-print'));

    expect(electronPrinter.printHtmlToWindowsPrinter).toHaveBeenCalledTimes(1);
    expect(electronPrinter.printHtmlToWindowsPrinter).toHaveBeenCalledWith({
      html: expect.stringContaining('<div class="paid">RECEIPT</div>'),
      printerName: '4BARCODE 4B-2054TG',
      labelSize: '4x3',
      outputDir,
    });
  });

  test('print bridge source does not depend on PDF shell printing', async () => {
    const packageJson = JSON.parse(await fs.readFile(path.resolve(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const printerSource = await fs.readFile(path.resolve(process.cwd(), 'src/printer.ts'), 'utf8');

    expect(packageJson.dependencies).not.toHaveProperty('pdf-to-printer');
    expect(printerSource).not.toContain('pdf-to-printer');
    expect(printerSource).not.toContain('shell.open');
    expect(printerSource).not.toContain('openPath');
  });

  test('rejects old pending test labels without the current template version', async () => {
    setBridgeEnv({ LABEL_SIZE: '4x3' });

    const { renderJobPdf } = await import('./printer');
    await expect(
      renderJobPdf({
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
      }),
    ).rejects.toThrow();
  });
});

function setBridgeEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    BACKEND_URL: 'https://kanika-boutique.onrender.com',
    PRINT_AGENT_TOKEN: 'test_print_agent_token_value_32_chars',
    DEVICE_ID: 'test-device',
    PRINTER_NAME: '4BARCODE 4B-2054TG',
    POLL_INTERVAL_MS: '3000',
    HEARTBEAT_INTERVAL_MS: '30000',
    PRINT_JOB_BATCH_SIZE: '1',
    LABEL_SIZE: '4x3',
    PRINT_DRY_RUN: 'true',
    OUTPUT_DIR: outputDir,
    ...overrides,
  });
}

function onlineOrderJob(id: string) {
  return {
    id,
    type: 'ORDER_LABEL' as const,
    status: 'CLAIMED' as const,
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    payload: {
      templateVersion: 'online-order-label-v1',
      storeName: 'Kanika Designs',
      orderId: 'KD-TEST-1001',
      customerName: 'Priya Sharma',
      maskedPhone: '98XXXXXX21',
      phoneMasked: '98XXXXXX21',
      addressLine1: 'H.No. 25, Sector 14',
      addressLine2: 'Near Main Market',
      city: 'Sonipat',
      state: 'Haryana',
      pincode: '131001',
      productName: 'Pure Cotton Suit With Long Name',
      sku: 'KD-PCS-101',
      size: '40',
      quantity: 1,
      paymentType: 'UPI',
      paymentStatus: 'PAID',
      amount: 2270,
      barcodeValue: 'KD-TEST-1001',
    },
  };
}

function manualReceiptJob(id: string) {
  return {
    id,
    type: 'OFFLINE_CUSTOMER_SLIP' as const,
    status: 'CLAIMED' as const,
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
    },
  };
}

function manualReturnSlipJob(id: string) {
  return {
    id,
    type: 'OFFLINE_RETURN_SLIP' as const,
    status: 'CLAIMED' as const,
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    payload: {
      templateVersion: 'manual-return-slip-v1',
      storeName: 'KANIKA DESIGNS',
      receiptId: 'MR-2026-0001',
      returnId: 'RET-2026-0001',
      customerName: 'test-1',
      phoneMasked: '74XXXXXX41',
      createdAt: '2026-06-17T10:29:00.000Z',
      refundMethod: 'CASH',
      refundAmount: 1760,
      reason: 'Customer returned item',
      items: [
        {
          name: 'Three-piece Kurti',
          sku: 'three-piece-kurtis-mq6b1e77',
          size: '38',
          quantity: 1,
          refundAmount: 1760,
        },
      ],
      barcodeValue: 'RET-2026-0001',
    },
  };
}
