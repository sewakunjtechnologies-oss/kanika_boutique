import { createBackendTestLabel, backendReachable } from './backendClient';
import { bridgeEnv } from './config';
import { buildDiagnostic, listPrinters, printPdf, renderJobPdf } from './printer';
import type { PrintJobDto } from './backendClient';

const command = process.argv[2];

async function main(): Promise<void> {
  switch (command) {
    case 'printers:list': {
      const printers = await listPrinters();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(printers, null, 2));
      return;
    }
    case 'bridge:dry-run': {
      const filePath = await renderJobPdf(sampleJob());
      // eslint-disable-next-line no-console
      console.log(`Dry-run PDF written: ${filePath}`);
      return;
    }
    case 'print:test': {
      const filePath = await renderJobPdf(sampleJob());
      await printPdf(filePath);
      // eslint-disable-next-line no-console
      console.log(bridgeEnv.PRINT_DRY_RUN ? `Dry-run test PDF written: ${filePath}` : `Sent test PDF to ${bridgeEnv.PRINTER_NAME}`);
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

function sampleJob(): PrintJobDto {
  return {
    id: 'preview-test-label',
    type: 'TEST_LABEL' as const,
    status: 'CLAIMED',
    attempts: 1,
    createdAt: new Date(0).toISOString(),
    payload: {
      storeName: 'Kanika Designs',
      templateVersion: 'test-label-v1',
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
      labelProfile: bridgeEnv.LABEL_PROFILE,
    },
  };
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
