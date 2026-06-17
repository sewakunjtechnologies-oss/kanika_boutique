import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  parseLabelPayload,
  parseManualReceiptReturnSlipPayload,
  parseOfflineCustomerSlipPayload,
  renderManualReceiptReturnSlipHtml,
  renderManualReceiptHtml,
  renderOnlineOrderHtml,
  renderTestLabel,
  resolveLabelSize,
  validateLabelPdfSize,
} from '@kda/labels';
import { bridgeEnv, outputPath } from './config';
import { electronPrintOptions, listElectronPrinters, pageSizeMicrons, printHtmlToWindowsPrinter } from './printing/electronHtmlPrinter';
import type { PrintJobDto } from './backendClient';

interface RenderedHtml {
  html: string;
  renderer: JobDispatch['renderer'];
}

export interface RenderedHtmlFile extends RenderedHtml {
  htmlPath: string;
}

export async function renderJobPdf(job: PrintJobDto): Promise<string> {
  logRenderDiagnostics(job);
  const rendered = await renderHtmlForJob(job);
  const pdf = await htmlToPdf(rendered.html);
  const validation = validateLabelPdfSize(pdf, bridgeEnv.LABEL_SIZE, 0.6);
  if (!validation.ok) {
    throw new Error(`generated PDF size mismatch: ${validation.reason ?? 'unknown'}`);
  }

  await fs.mkdir(outputPath(), { recursive: true });
  const base = `${job.id}-${bridgeEnv.LABEL_SIZE}`;
  const htmlPath = outputPath(`${base}.html`);
  const pdfPath = outputPath(`${base}.pdf`);
  await fs.writeFile(htmlPath, rendered.html, 'utf8');
  await fs.writeFile(pdfPath, pdf);
  // eslint-disable-next-line no-console
  console.log(`HTML renderer=${rendered.renderer} html=${htmlPath} pdf=${pdfPath}`);
  return pdfPath;
}

export async function renderJobHtmlFile(job: PrintJobDto): Promise<RenderedHtmlFile> {
  logRenderDiagnostics(job);
  const rendered = await renderHtmlForJob(job);
  await fs.mkdir(outputPath(), { recursive: true });
  const htmlPath = outputPath(`${job.id}-${bridgeEnv.LABEL_SIZE}.html`);
  await fs.writeFile(htmlPath, rendered.html, 'utf8');
  // eslint-disable-next-line no-console
  console.log(`HTML renderer=${rendered.renderer} html=${htmlPath}`);
  return { ...rendered, htmlPath };
}

export async function renderHtmlForJob(job: PrintJobDto): Promise<RenderedHtml> {
  if (job.type === 'ORDER_LABEL') {
    const payload = parseLabelPayload(job.payload);
    if (payload.templateVersion !== 'online-order-label-v1') {
      throw new Error(`template mismatch for ORDER_LABEL: ${payload.templateVersion}`);
    }
    return {
      html: await renderOnlineOrderHtml(payload, bridgeEnv.LABEL_SIZE),
      renderer: 'renderOnlineOrderHtml',
    };
  }
  if (job.type === 'TEST_LABEL') {
    const payload = parseLabelPayload(job.payload);
    if (payload.templateVersion !== 'test-label-v1') {
      throw new Error(`template mismatch for TEST_LABEL: ${payload.templateVersion}`);
    }
    return {
      html: await renderTestLabel(payload, bridgeEnv.LABEL_SIZE),
      renderer: 'renderTestLabel',
    };
  }
  if (job.type === 'OFFLINE_CUSTOMER_SLIP') {
    const payload = parseOfflineCustomerSlipPayload(job.payload);
    if (payload.templateVersion !== 'manual-receipt-v1') {
      throw new Error(`template mismatch for OFFLINE_CUSTOMER_SLIP: ${payload.templateVersion}`);
    }
    return {
      html: await renderManualReceiptHtml(payload, bridgeEnv.LABEL_SIZE),
      renderer: 'renderManualReceiptHtml',
    };
  }
  if (job.type === 'OFFLINE_RETURN_SLIP') {
    const payload = parseManualReceiptReturnSlipPayload(job.payload);
    if (payload.templateVersion !== 'manual-return-slip-v1') {
      throw new Error(`template mismatch for OFFLINE_RETURN_SLIP: ${payload.templateVersion}`);
    }
    return {
      html: await renderManualReceiptReturnSlipHtml(payload, bridgeEnv.LABEL_SIZE),
      renderer: 'renderManualReceiptReturnSlipHtml',
    };
  }
  throw new Error(`unsupported print job type: ${job.type}`);
}

export async function htmlToPdf(html: string): Promise<Buffer> {
  const size = resolveLabelSize(bridgeEnv.LABEL_SIZE);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: {
        width: Math.round((size.widthMm / 25.4) * 96),
        height: Math.round((size.heightMm / 25.4) * 96),
      },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForSelector('#barcode', { state: 'attached' });
    await page.evaluate('document.fonts ? document.fonts.ready : Promise.resolve()');
    const pdf = await page.pdf({
      width: `${size.widthMm}mm`,
      height: `${size.heightMm}mm`,
      printBackground: true,
      margin: {
        top: '0mm',
        right: '0mm',
        bottom: '0mm',
        left: '0mm',
      },
      preferCSSPageSize: true,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function printRenderedHtml(rendered: Pick<RenderedHtmlFile, 'html' | 'renderer' | 'htmlPath'>): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(
    [
      `Print selected: printer="${bridgeEnv.PRINTER_NAME}"`,
      `labelSize=${bridgeEnv.LABEL_SIZE}`,
      `pageSizeMicrons=${pageSizeMicrons(bridgeEnv.LABEL_SIZE).width}x${pageSizeMicrons(bridgeEnv.LABEL_SIZE).height}`,
      `renderer=${rendered.renderer}`,
      `html=${rendered.htmlPath}`,
      `dryRun=${bridgeEnv.PRINT_DRY_RUN}`,
    ].join('\n'),
  );
  if (bridgeEnv.PRINT_DRY_RUN) {
    // eslint-disable-next-line no-console
    console.log(`Dry-run enabled; not sending HTML to printer. HTML saved at ${rendered.htmlPath}`);
    return;
  }
  await printHtmlToWindowsPrinter({
    html: rendered.html,
    printerName: bridgeEnv.PRINTER_NAME,
    labelSize: bridgeEnv.LABEL_SIZE,
    outputDir: bridgeEnv.OUTPUT_DIR,
  });
}

export async function printJobHtml(job: PrintJobDto): Promise<RenderedHtmlFile> {
  const rendered = await renderJobHtmlFile(job);
  await printRenderedHtml(rendered);
  return rendered;
}

export async function listPrinters(): Promise<unknown[]> {
  return listElectronPrinters();
}

export async function getDefaultPrinterSafe(): Promise<unknown | null> {
  try {
    const printers = await listPrinters();
    return printers.find((printer) => {
      if (!printer || typeof printer !== 'object') return false;
      return Boolean((printer as { isDefault?: unknown; default?: unknown }).isDefault ?? (printer as { default?: unknown }).default);
    }) ?? null;
  } catch {
    return null;
  }
}

export async function buildDiagnostic(): Promise<Record<string, unknown>> {
  let installedPrinters: unknown[] = [];
  let printerError: string | null = null;
  try {
    installedPrinters = await listPrinters();
  } catch (err) {
    printerError = err instanceof Error ? err.message : 'failed to list printers';
  }

  const selectedSize = resolveLabelSize(bridgeEnv.LABEL_SIZE);
  const electronOptions = electronPrintOptions(bridgeEnv.PRINTER_NAME, bridgeEnv.LABEL_SIZE);
  return {
    selectedPrinter: bridgeEnv.PRINTER_NAME,
    installedPrinters,
    defaultPrinter: await getDefaultPrinterSafe(),
    platform: os.platform(),
    release: os.release(),
    labelSize: bridgeEnv.LABEL_SIZE,
    printJobBatchSize: bridgeEnv.PRINT_JOB_BATCH_SIZE,
    renderDiagnostics: renderDiagnostics(),
    pdf: {
      widthMm: selectedSize.widthMm,
      heightMm: selectedSize.heightMm,
      rotation: 0,
    },
    pageSizeMicrons: electronOptions.pageSize,
    electronPrint: {
      deviceName: electronOptions.deviceName,
      landscape: electronOptions.landscape,
      margins: electronOptions.margins,
      copies: electronOptions.copies,
    },
    dryRun: bridgeEnv.PRINT_DRY_RUN,
    backendUrl: bridgeEnv.BACKEND_URL,
    tokenConfigured: Boolean(bridgeEnv.PRINT_AGENT_TOKEN),
    outputDir: path.resolve(process.cwd(), bridgeEnv.OUTPUT_DIR),
    printerError,
  };
}

export interface JobDispatch {
  requestedTemplate: 'manual-receipt' | 'online-order-label' | 'test-label' | 'manual-return-slip';
  renderer: 'renderManualReceiptHtml' | 'renderManualReceiptReturnSlipHtml' | 'renderOnlineOrderHtml' | 'renderTestLabel';
}

export function dispatchForJobType(type: PrintJobDto['type']): JobDispatch {
  switch (type) {
    case 'OFFLINE_CUSTOMER_SLIP':
      return { requestedTemplate: 'manual-receipt', renderer: 'renderManualReceiptHtml' };
    case 'OFFLINE_RETURN_SLIP':
      return { requestedTemplate: 'manual-return-slip', renderer: 'renderManualReceiptReturnSlipHtml' };
    case 'ORDER_LABEL':
      return { requestedTemplate: 'online-order-label', renderer: 'renderOnlineOrderHtml' };
    case 'TEST_LABEL':
      return { requestedTemplate: 'test-label', renderer: 'renderTestLabel' };
    default:
      throw new Error(`unsupported print job type: ${type}`);
  }
}

export function renderDiagnostics(job?: PrintJobDto): Record<string, string | number | boolean> {
  const size = resolveLabelSize(bridgeEnv.LABEL_SIZE);
  const microns = pageSizeMicrons(bridgeEnv.LABEL_SIZE);
  const dispatch = job ? dispatchForJobType(job.type) : null;
  return {
    requestedTemplate: dispatch?.requestedTemplate ?? 'unknown',
    jobType: job?.type ?? 'unknown',
    renderer: dispatch?.renderer ?? 'unknown',
    jobId: job?.id ?? '',
    receiptId: job?.type === 'OFFLINE_CUSTOMER_SLIP' ? String((job.payload as { receiptId?: unknown }).receiptId ?? '') : '',
    labelSize: bridgeEnv.LABEL_SIZE,
    physicalPage: `${size.widthMm}x${size.heightMm}mm`,
    pageSizeMicrons: `${microns.width}x${microns.height}`,
    rotation: 0,
    selectedPrinter: bridgeEnv.PRINTER_NAME,
    dryRun: bridgeEnv.PRINT_DRY_RUN,
  };
}

function logRenderDiagnostics(job: PrintJobDto): void {
  const d = renderDiagnostics(job);
  // eslint-disable-next-line no-console
  console.log(
    [
      `requestedTemplate=${d.requestedTemplate}`,
      `jobType=${d.jobType}`,
      `renderer=${d.renderer}`,
      `physicalPage=${d.physicalPage}`,
      `pageSizeMicrons=${d.pageSizeMicrons}`,
      `rotation=${d.rotation}`,
      d.jobId ? `jobId=${d.jobId}` : '',
      d.receiptId ? `receiptId=${d.receiptId}` : '',
      `labelSize=${d.labelSize}`,
      `selectedPrinter=${d.selectedPrinter}`,
      `dryRun=${d.dryRun}`,
    ].filter(Boolean).join('\n'),
  );
}
