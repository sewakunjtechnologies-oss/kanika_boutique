import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getDefaultPrinter, getPrinters, print } from 'pdf-to-printer';
import type { PrintOptions } from 'pdf-to-printer';
import {
  LabelPayload,
  LabelProfile,
  parseLabelPayload,
  renderOrderLabel,
  resolveLabelProfile,
  validateLabelPdfSize,
} from '@kda/labels';
import { bridgeEnv, outputPath } from './config';
import type { PrintJobDto } from './backendClient';

export async function renderJobPdf(job: PrintJobDto): Promise<string> {
  const payload = payloadForJob(job);
  const profile = selectedBridgeProfile();
  const pdf = await renderOrderLabel({ ...payload, labelProfile: profile.name }, profile);
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
    pdf: {
      widthMm: selectedProfile.widthMm,
      heightMm: selectedProfile.heightMm,
      orientation: selectedProfile.orientation,
      rotation: selectedProfile.rotation,
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

function payloadForJob(job: PrintJobDto): LabelPayload {
  if (job.type === 'ORDER_LABEL' || job.type === 'TEST_LABEL') {
    return parseLabelPayload(job.payload);
  }
  throw new Error(`unsupported print job type: ${job.type}`);
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
