import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

describe('print bridge preview CLI template resolution', () => {
  beforeEach(() => {
    setBridgeEnv();
    vi.resetModules();
  });

  test('supports --template=value and --template value forms', async () => {
    const { parseTemplateArg } = await import('./cli');

    expect(parseTemplateArg(['--template=manual-receipt'])).toBe('manual-receipt');
    expect(parseTemplateArg(['--template', 'online-order-label'])).toBe('online-order-label');
    expect(parseTemplateArg(['--foo', 'bar', '--template', 'test-label'])).toBe('test-label');
  });

  test('preview:manual resolves OFFLINE_CUSTOMER_SLIP', async () => {
    const { resolvePreviewTemplate, sampleJob } = await import('./cli');

    const resolution = resolvePreviewTemplate('manual-receipt');
    const job = sampleJob(resolution.resolvedTemplate);

    expect(resolution).toMatchObject({
      requestedTemplate: 'manual-receipt',
      resolvedTemplate: 'manual-receipt',
      jobType: 'OFFLINE_CUSTOMER_SLIP',
      renderer: 'renderManualReceiptHtml',
    });
    expect(job.type).toBe('OFFLINE_CUSTOMER_SLIP');
    expect(`${job.id}-4x3.pdf`).toBe('preview-manual-receipt-4x3.pdf');
  });

  test('preview:online resolves ORDER_LABEL', async () => {
    const { resolvePreviewTemplate, sampleJob } = await import('./cli');

    const resolution = resolvePreviewTemplate('online-order-label');
    const job = sampleJob(resolution.resolvedTemplate);

    expect(resolution).toMatchObject({
      requestedTemplate: 'online-order-label',
      resolvedTemplate: 'online-order-label',
      jobType: 'ORDER_LABEL',
      renderer: 'renderOnlineOrderHtml',
    });
    expect(job.type).toBe('ORDER_LABEL');
    expect(`${job.id}-4x3.pdf`).toBe('preview-online-order-label-4x3.pdf');
  });

  test('preview:test resolves TEST_LABEL without being used as a fallback', async () => {
    const { resolvePreviewTemplate, sampleJob } = await import('./cli');

    const resolution = resolvePreviewTemplate('test-label');
    const job = sampleJob(resolution.resolvedTemplate);

    expect(resolution).toMatchObject({
      requestedTemplate: 'test-label',
      resolvedTemplate: 'test-label',
      jobType: 'TEST_LABEL',
      renderer: 'renderTestLabel',
    });
    expect(job.type).toBe('TEST_LABEL');
    expect(`${job.id}-4x3.pdf`).toBe('preview-test-label-4x3.pdf');
  });

  test('invalid template exits with code 1 and lists valid templates', () => {
    const result = spawnSync(
      process.execPath,
      ['-r', 'ts-node/register', 'src/cli.ts', 'bridge:dry-run', '--template=bad-template'],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, ...bridgeEnvForTest() },
        encoding: 'utf8',
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid template "bad-template".');
    expect(result.stderr).toContain('Valid templates: manual-receipt, online-order-label, test-label');
    expect(result.stdout).not.toContain('jobType=TEST_LABEL');
  });

  test('manual and online output paths differ', async () => {
    const { sampleJob } = await import('./cli');

    const manual = sampleJob('manual-receipt');
    const online = sampleJob('online-order-label');

    expect(`${manual.id}-4x3.pdf`).toBe('preview-manual-receipt-4x3.pdf');
    expect(`${online.id}-4x3.pdf`).toBe('preview-online-order-label-4x3.pdf');
    expect(manual.id).not.toBe(online.id);
  });

  test('manual output does not contain address while online output contains address', async () => {
    const { sampleJob } = await import('./cli');
    const { parseLabelPayload, parseOfflineCustomerSlipPayload, renderManualReceiptHtml, renderOnlineOrderHtml } =
      await import('@kda/labels');

    const manual = sampleJob('manual-receipt');
    const online = sampleJob('online-order-label');
    const manualHtml = await renderManualReceiptHtml(parseOfflineCustomerSlipPayload(manual.payload), '4x3');
    const onlineHtml = await renderOnlineOrderHtml(parseLabelPayload(online.payload), '4x3');

    expect(manualHtml).not.toContain('<strong>Address:</strong>');
    expect(manualHtml).not.toContain('<strong>Pincode:</strong>');
    expect(onlineHtml).toContain('<strong>Address:</strong>');
    expect(onlineHtml).toContain('<strong>Pincode:</strong>');
  });
});

function setBridgeEnv(): void {
  Object.assign(process.env, bridgeEnvForTest());
}

function bridgeEnvForTest(): Record<string, string> {
  return {
    BACKEND_URL: 'https://kanika-boutique.onrender.com',
    PRINT_AGENT_TOKEN: 'test_print_agent_token_value_32_chars',
    DEVICE_ID: 'test-device',
    PRINTER_NAME: '4BARCODE 4B-2054TG',
    POLL_INTERVAL_MS: '3000',
    HEARTBEAT_INTERVAL_MS: '30000',
    PRINT_JOB_BATCH_SIZE: '1',
    LABEL_SIZE: '4x3',
    PRINT_DRY_RUN: 'true',
    OUTPUT_DIR: './tmp-test-output',
  };
}
