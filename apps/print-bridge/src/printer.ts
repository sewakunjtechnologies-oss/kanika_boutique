import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPrinter, getPrinters, print } from 'pdf-to-printer';
import {
  LABEL_PROFILES,
  LabelPayload,
  parseLabelPayload,
  renderOrderLabel,
  validateLabelPdfSize,
} from '@kda/labels';
import { bridgeEnv, outputPath } from './config';
import type { PrintJobDto } from './backendClient';

export async function renderJobPdf(job: PrintJobDto): Promise<string> {
  const payload = payloadForJob(job);
  const profile = bridgeEnv.LABEL_PROFILE;
  const pdf = await renderOrderLabel({ ...payload, labelProfile: profile }, profile);
  const validation = validateLabelPdfSize(pdf, profile, 0.6);
  if (!validation.ok) {
    throw new Error(`generated PDF size mismatch: ${validation.reason ?? 'unknown'}`);
  }
  await fs.mkdir(outputPath(), { recursive: true });
  const filename = `${job.id}-${profile}.pdf`;
  const filePath = outputPath(filename);
  await fs.writeFile(filePath, pdf);
  return filePath;
}

export async function printPdf(filePath: string): Promise<void> {
  if (bridgeEnv.PRINT_DRY_RUN) return;
  const options = {
    printer: bridgeEnv.PRINTER_NAME,
    scale: bridgeEnv.PRINT_SCALE_MODE,
    orientation: 'portrait' as const,
    monochrome: true,
    silent: true,
  };
  await print(filePath, options);
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

  const selectedProfile = LABEL_PROFILES[bridgeEnv.LABEL_PROFILE];
  return {
    selectedPrinter: bridgeEnv.PRINTER_NAME,
    installedPrinters,
    defaultPrinter: await getDefaultPrinterSafe(),
    platform: os.platform(),
    release: os.release(),
    labelProfile: bridgeEnv.LABEL_PROFILE,
    expectedDimensionsMm: {
      width: selectedProfile.widthMm,
      height: selectedProfile.heightMm,
      contentWidth: selectedProfile.contentWidthMm,
      contentHeight: selectedProfile.contentHeightMm,
    },
    dryRun: bridgeEnv.PRINT_DRY_RUN,
    backendUrl: bridgeEnv.BACKEND_URL,
    tokenConfigured: Boolean(bridgeEnv.PRINT_AGENT_TOKEN),
    outputDir: path.resolve(process.cwd(), bridgeEnv.OUTPUT_DIR),
    printerError,
  };
}

function payloadForJob(job: PrintJobDto): LabelPayload {
  if (job.type === 'ORDER_LABEL' || job.type === 'TEST_LABEL') {
    return parseLabelPayload(job.payload);
  }
  throw new Error(`unsupported print job type: ${job.type}`);
}
