import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPrinter, getPrinters, print } from 'pdf-to-printer';
import type { PrintOptions } from 'pdf-to-printer';
import {
  LabelProfile,
  parseLabelPayload,
  parseOfflineCustomerSlipPayload,
  renderManualReceipt,
  renderOnlineOrderLabel,
  renderTestLabel,
  resolveLabelProfile,
  validateLabelPdfSize,
} from '@kda/labels';
import { bridgeEnv, outputPath } from './config';
import type { PrintJobDto } from './backendClient';

export async function renderJobPdf(job: PrintJobDto): Promise<string> {
  const profile = selectedBridgeProfile();
  logRenderDiagnostics(job);
  const pdf = await renderPdfForJob(job, profile);
  const validation = validateLabelPdfSize(pdf, profile, 0.6);
  if (!validation.ok) {
    throw new Error(`generated PDF size mismatch: ${validation.reason ?? 'unknown'}`);
  }
  await fs.mkdir(outputPath(), { recursive: true });
  const filename = `${job.id}-${profile.name}.pdf`;
  const filePath = outputPath(filename);
  await fs.writeFile(filePath, pdf);
  return filePath;
}

async function renderPdfForJob(job: PrintJobDto, profile: LabelProfile): Promise<Buffer> {
  if (job.type === 'ORDER_LABEL') {
    const payload = parseLabelPayload(job.payload);
    if (payload.templateVersion !== 'online-order-label-v1') {
      throw new Error(`template mismatch for ORDER_LABEL: ${payload.templateVersion}`);
    }
    return renderOnlineOrderLabel({ ...payload, labelProfile: profile.name }, profile);
  }
  if (job.type === 'TEST_LABEL') {
    const payload = parseLabelPayload(job.payload);
    if (payload.templateVersion !== 'test-label-v1') {
      throw new Error(`template mismatch for TEST_LABEL: ${payload.templateVersion}`);
    }
    return renderTestLabel({ ...payload, labelProfile: profile.name }, profile);
  }
  if (job.type === 'OFFLINE_CUSTOMER_SLIP') {
    const payload = parseOfflineCustomerSlipPayload(job.payload);
    if (payload.templateVersion !== 'manual-receipt-v1') {
      throw new Error(`template mismatch for OFFLINE_CUSTOMER_SLIP: ${payload.templateVersion}`);
    }
    return renderManualReceipt({ ...payload, labelProfile: '4x3_standard' }, profile);
  }
  throw new Error(`unsupported print job type: ${job.type}`);
}

export async function printPdf(filePath: string): Promise<void> {
  const profile = selectedBridgeProfile();
  if (profile.rotation !== 0) {
    throw new Error('Label printing only supports rotation 0 for the 4BARCODE media profile.');
  }
  const options: PrintOptions = {
    printer: bridgeEnv.PRINTER_NAME,
    scale: bridgeEnv.PRINT_SCALE_MODE,
    orientation: profile.orientation,
    paperSize: profile.paperSizeName,
    monochrome: true,
    silent: true,
    copies: 1,
  };
  // eslint-disable-next-line no-console
  console.log(
    `Print selected: printer="${bridgeEnv.PRINTER_NAME}" profile=${profile.name} pdf=${profile.widthMm}x${profile.heightMm}mm orientation=${profile.orientation} rotation=${profile.rotation} paper="${profile.paperSizeName}" scale=${bridgeEnv.PRINT_SCALE_MODE} dryRun=${bridgeEnv.PRINT_DRY_RUN}`,
  );
  if (bridgeEnv.PRINT_DRY_RUN) {
    // eslint-disable-next-line no-console
    console.log(`Dry-run enabled; not sending PDF to printer. PDF saved at ${filePath}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`Print start: ${filePath}`);
  await print(filePath, options);
  // eslint-disable-next-line no-console
  console.log(`Print complete: ${filePath}`);
}

export async function listPrinters(): Promise<unknown[]> {
  return getPrinters();
}

export async function getDefaultPrinterSafe(): Promise<unknown | null> {
  try {
    return await getDefaultPrinter();
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

  const selectedProfile = selectedBridgeProfile();
  return {
    selectedPrinter: bridgeEnv.PRINTER_NAME,
    installedPrinters,
    defaultPrinter: await getDefaultPrinterSafe(),
    platform: os.platform(),
    release: os.release(),
    labelProfile: bridgeEnv.LABEL_PROFILE,
    printJobBatchSize: bridgeEnv.PRINT_JOB_BATCH_SIZE,
    renderDiagnostics: renderDiagnostics(),
    pdf: {
      widthMm: selectedProfile.widthMm,
      heightMm: selectedProfile.heightMm,
      designWidthMm: selectedProfile.designWidthMm,
      designHeightMm: selectedProfile.designHeightMm,
      contentWidthMm: selectedProfile.contentWidthMm,
      contentHeightMm: selectedProfile.contentHeightMm,
      offsetXmm: selectedProfile.offsetXmm,
      offsetYmm: selectedProfile.offsetYmm,
      orientation: selectedProfile.orientation,
      rotation: selectedProfile.rotation,
      rendererRotation: selectedProfile.rendererRotation,
    },
    expectedDimensionsMm: {
      width: selectedProfile.widthMm,
      height: selectedProfile.heightMm,
      safeWidth: selectedProfile.safeWidthMm,
      safeHeight: selectedProfile.safeHeightMm,
      orientation: selectedProfile.orientation,
      rotation: selectedProfile.rotation,
      paperSize: selectedProfile.paperSizeName,
    },
    dryRun: bridgeEnv.PRINT_DRY_RUN,
    backendUrl: bridgeEnv.BACKEND_URL,
    tokenConfigured: Boolean(bridgeEnv.PRINT_AGENT_TOKEN),
    outputDir: path.resolve(process.cwd(), bridgeEnv.OUTPUT_DIR),
    printerError,
  };
}

function selectedBridgeProfile(): LabelProfile {
  const base = resolveLabelProfile(bridgeEnv.LABEL_PROFILE);
  return resolveLabelProfile(base, {
    widthMm: bridgeEnv.LABEL_WIDTH_MM ?? base.widthMm,
    heightMm: bridgeEnv.LABEL_HEIGHT_MM ?? base.heightMm,
    orientation: bridgeEnv.PRINT_ORIENTATION,
    rotation: bridgeEnv.PRINT_ROTATION,
  });
}

/**
 * Renderer/printer diagnostics. The current 4BARCODE media profile keeps all
 * rotation values at 0: the PDF page is physically 101.6 x 76.2 mm, and
 * Windows prints Portrait / Normal at 100% with no fit or auto-rotation.
 */
export function renderDiagnostics(job?: PrintJobDto): Record<string, string | number | boolean> {
  const profile = selectedBridgeProfile();
  return {
    jobType: job?.type ?? 'unknown',
    jobId: job?.id ?? '',
    receiptId: job?.type === 'OFFLINE_CUSTOMER_SLIP' ? String((job.payload as { receiptId?: unknown }).receiptId ?? '') : '',
    profile: profile.name,
    physicalPage: `${profile.widthMm}x${profile.heightMm}mm`,
    logicalCanvas: `${profile.designWidthMm}x${profile.designHeightMm}mm`,
    rendererRotation: profile.rendererRotation,
    pdfRotation: profile.rotation,
    windowsOrientation: bridgeEnv.PRINT_ORIENTATION,
    windowsRotation: bridgeEnv.PRINT_ROTATION,
    scale: bridgeEnv.PRINT_SCALE_MODE,
    selectedPrinter: bridgeEnv.PRINTER_NAME,
    dryRun: bridgeEnv.PRINT_DRY_RUN,
  };
}

function logRenderDiagnostics(job: PrintJobDto): void {
  const d = renderDiagnostics(job);
  // eslint-disable-next-line no-console
  console.log(
    [
      `jobType=${d.jobType}`,
      d.jobId ? `jobId=${d.jobId}` : '',
      d.receiptId ? `receiptId=${d.receiptId}` : '',
      `profile=${d.profile}`,
      `physicalPage=${d.physicalPage}`,
      `logicalCanvas=${d.logicalCanvas}`,
      `rendererRotation=${d.rendererRotation}`,
      `pdfRotation=${d.pdfRotation}`,
      `windowsOrientation=${d.windowsOrientation}`,
      `windowsRotation=${d.windowsRotation}`,
      `scale=${d.scale}`,
      `selectedPrinter=${d.selectedPrinter}`,
      `dryRun=${d.dryRun}`,
    ].filter(Boolean).join('\n'),
  );
}
