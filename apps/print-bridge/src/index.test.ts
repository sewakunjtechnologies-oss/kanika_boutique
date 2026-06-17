import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('print bridge job processing', () => {
  beforeEach(() => {
    vi.resetModules();
    Object.assign(process.env, {
      BACKEND_URL: 'https://kanika-boutique.onrender.com',
      PRINT_AGENT_TOKEN: 'test_print_agent_token_value_32_chars',
      DEVICE_ID: 'test-device',
      PRINTER_NAME: '4BARCODE 4B-2054TG',
      POLL_INTERVAL_MS: '3000',
      HEARTBEAT_INTERVAL_MS: '30000',
      PRINT_JOB_BATCH_SIZE: '1',
      LABEL_SIZE: '4x3',
      PRINT_DRY_RUN: 'false',
      OUTPUT_DIR: './tmp-test-output',
    });
  });

  test('successful Electron HTML print marks job PRINTED', async () => {
    const mocks = installBridgeMocks();
    mocks.getNextJob.mockResolvedValue(sampleJob());
    mocks.renderJobHtmlFile.mockResolvedValue({
      html: '<html><body>KANIKA DESIGNS</body></html>',
      htmlPath: './print-output/job_1.html',
      renderer: 'renderManualReceiptHtml',
    });
    mocks.printRenderedHtml.mockResolvedValue(undefined);

    const { processNextJob } = await import('./index');
    await expect(processNextJob()).resolves.toBe('completed');

    expect(mocks.markPrinting).toHaveBeenCalledWith('job_1');
    expect(mocks.printRenderedHtml).toHaveBeenCalledTimes(1);
    expect(mocks.markPrinted).toHaveBeenCalledWith('job_1');
    expect(mocks.markFailed).not.toHaveBeenCalled();
  });

  test('failed Electron HTML print marks job FAILED', async () => {
    const mocks = installBridgeMocks();
    mocks.getNextJob.mockResolvedValue(sampleJob());
    mocks.renderJobHtmlFile.mockResolvedValue({
      html: '<html><body>KANIKA DESIGNS</body></html>',
      htmlPath: './print-output/job_1.html',
      renderer: 'renderManualReceiptHtml',
    });
    mocks.printRenderedHtml.mockRejectedValue(new Error('printer offline'));

    const { processNextJob } = await import('./index');
    await expect(processNextJob()).resolves.toBe('failed');

    expect(mocks.markPrinting).toHaveBeenCalledWith('job_1');
    expect(mocks.markPrinted).not.toHaveBeenCalled();
    expect(mocks.markFailed).toHaveBeenCalledWith('job_1', 'printer offline');
  });

  test('dry-run marks DRY_RUN_COMPLETED instead of physically PRINTED', async () => {
    process.env.PRINT_DRY_RUN = 'true';
    const mocks = installBridgeMocks();
    mocks.getNextJob.mockResolvedValue(sampleJob());
    mocks.renderJobHtmlFile.mockResolvedValue({
      html: '<html><body>KANIKA DESIGNS</body></html>',
      htmlPath: './print-output/job_1.html',
      renderer: 'renderManualReceiptHtml',
    });
    mocks.printRenderedHtml.mockResolvedValue(undefined);

    const { processNextJob } = await import('./index');
    await expect(processNextJob()).resolves.toBe('completed');

    expect(mocks.markDryRunCompleted).toHaveBeenCalledWith('job_1');
    expect(mocks.markPrinted).not.toHaveBeenCalled();
  });
});

function installBridgeMocks() {
  const mocks = {
    getNextJob: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue(undefined),
    markPrinting: vi.fn().mockResolvedValue(undefined),
    markPrinted: vi.fn().mockResolvedValue(undefined),
    markDryRunCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
    renderJobHtmlFile: vi.fn(),
    printRenderedHtml: vi.fn(),
  };

  vi.doMock('./backendClient', () => ({
    getNextJob: mocks.getNextJob,
    heartbeat: mocks.heartbeat,
    markPrinting: mocks.markPrinting,
    markPrinted: mocks.markPrinted,
    markDryRunCompleted: mocks.markDryRunCompleted,
    markFailed: mocks.markFailed,
  }));
  vi.doMock('./printer', () => ({
    renderJobHtmlFile: mocks.renderJobHtmlFile,
    printRenderedHtml: mocks.printRenderedHtml,
  }));

  return mocks;
}

function sampleJob() {
  return {
    id: 'job_1',
    type: 'OFFLINE_CUSTOMER_SLIP' as const,
    status: 'CLAIMED' as const,
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    payload: {
      templateVersion: 'manual-receipt-v1',
      receiptId: 'MR-1',
      barcodeValue: 'MR-1',
    },
  };
}
