import { createBackendTestLabel, backendReachable } from './backendClient';
import { bridgeEnv } from './config';
import { buildDiagnostic, listPrinters, printPdf, renderJobPdf } from './printer';
import type { PrintJobDto } from './backendClient';

export const VALID_TEMPLATES = ['manual-receipt', 'online-order-label', 'test-label'] as const;
export type TemplateName = (typeof VALID_TEMPLATES)[number];

export interface PreviewTemplateResolution {
  requestedTemplate: string;
  resolvedTemplate: TemplateName;
  jobType: PrintJobDto['type'];
  renderer: 'renderManualReceiptHtml' | 'renderOnlineOrderHtml' | 'renderTestLabel';
}

export class TemplateArgumentError extends Error {
  constructor(message: string) {
    super(`${message}\nValid templates: ${VALID_TEMPLATES.join(', ')}`);
    this.name = 'TemplateArgumentError';
  }
}

export function parseTemplateArg(args: string[]): string {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) continue;
    if (arg.startsWith('--template=')) {
      const value = arg.slice('--template='.length).trim();
      if (!value) throw new TemplateArgumentError('Missing value for --template.');
      return value;
    }
    if (arg === '--template') {
      const value = args[i + 1]?.trim();
      if (!value || value.startsWith('--')) throw new TemplateArgumentError('Missing value for --template.');
      return value;
    }
  }
  throw new TemplateArgumentError('Missing --template argument.');
}

export function resolvePreviewTemplate(requestedTemplate: string): PreviewTemplateResolution {
  if (requestedTemplate === 'manual-receipt') {
    return {
      requestedTemplate,
      resolvedTemplate: 'manual-receipt',
      jobType: 'OFFLINE_CUSTOMER_SLIP',
      renderer: 'renderManualReceiptHtml',
    };
  }
  if (requestedTemplate === 'online-order-label') {
    return {
      requestedTemplate,
      resolvedTemplate: 'online-order-label',
      jobType: 'ORDER_LABEL',
      renderer: 'renderOnlineOrderHtml',
    };
  }
  if (requestedTemplate === 'test-label') {
    return {
      requestedTemplate,
      resolvedTemplate: 'test-label',
      jobType: 'TEST_LABEL',
      renderer: 'renderTestLabel',
    };
  }
  throw new TemplateArgumentError(`Invalid template "${requestedTemplate}".`);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  switch (command) {
    case 'printers:list': {
      const printers = await listPrinters();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(printers, null, 2));
      return;
    }
    case 'bridge:dry-run': {
      const resolution = resolvePreviewTemplate(parseTemplateArg(args));
      const filePath = await renderJobPdf(sampleJob(resolution.resolvedTemplate));
      logPreviewDiagnostics(resolution, filePath);
      // eslint-disable-next-line no-console
      console.log(`Dry-run PDF written: ${filePath}`);
      return;
    }
    case 'print:test': {
      const resolution = resolvePreviewTemplate(parseTemplateArg(args));
      const job = sampleJob(resolution.resolvedTemplate);
      const filePath = await renderJobPdf(job);
      await printPdf(filePath);
      logPreviewDiagnostics(resolution, filePath);
      // eslint-disable-next-line no-console
      console.log(
        bridgeEnv.PRINT_DRY_RUN
          ? `Dry-run ${resolution.resolvedTemplate} PDF written: ${filePath}`
          : `Sent ${resolution.resolvedTemplate} PDF to ${bridgeEnv.PRINTER_NAME}`,
      );
      return;
    }
    case 'printer:diagnose': {
      const diagnostic = await buildDiagnostic();
      diagnostic.backendReachable = await backendReachable();
      diagnostic.backendTestLabelCreated = false;
      try {
        await createBackendTestLabel();
        diagnostic.backendTestLabelCreated = true;
      } catch {
        diagnostic.backendTestLabelCreated = false;
      }
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(diagnostic, null, 2));
      return;
    }
    default:
      throw new Error(`Unknown command: ${command ?? '(missing)'}`);
  }
}

export function sampleJob(template: TemplateName): PrintJobDto {
  if (template === 'manual-receipt') {
    return {
      id: 'preview-manual-receipt',
      type: 'OFFLINE_CUSTOMER_SLIP' as const,
      status: 'CLAIMED',
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: {
        templateVersion: 'manual-receipt-v1',
        storeName: 'Kanika Designs',
        receiptId: 'MR-2026-0001',
        customerName: 'Priya Sharma',
        phoneMasked: '98XXXXXX21',
        createdAt: new Date(0).toISOString(),
        paymentMethod: 'CASH',
        subtotal: 2270,
        delivery: 0,
        discount: 0,
        total: 2270,
        items: [
          { name: 'Pure Cotton Suit With Long Name', sku: 'KD-PCS-101', size: '40', quantity: 1, unitPrice: 2270, amount: 2270 },
        ],
        barcodeValue: 'MR-2026-0001',
      },
    };
  }

  const onlinePayload = {
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
  };

  if (template === 'online-order-label') {
    return {
      id: 'preview-online-order-label',
      type: 'ORDER_LABEL' as const,
      status: 'CLAIMED',
      attempts: 1,
      createdAt: new Date(0).toISOString(),
      payload: { ...onlinePayload, templateVersion: 'online-order-label-v1' },
    };
  }

  return {
    id: 'preview-test-label',
    type: 'TEST_LABEL' as const,
    status: 'CLAIMED',
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    payload: { ...onlinePayload, templateVersion: 'test-label-v1' },
  };
}

function logPreviewDiagnostics(resolution: PreviewTemplateResolution, outputPath: string): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      `requestedTemplate=${resolution.requestedTemplate}`,
      `resolvedTemplate=${resolution.resolvedTemplate}`,
      `jobType=${resolution.jobType}`,
      `renderer=${resolution.renderer}`,
      `outputPath=${outputPath}`,
    ].join('\n'),
  );
}

if (require.main === module) {
  runCli().catch((err) => {
  // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
