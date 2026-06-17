import { createBackendTestLabel, backendReachable } from './backendClient';
import { bridgeEnv } from './config';
import { buildDiagnostic, listPrinters, printPdf, renderJobPdf } from './printer';
import type { PrintJobDto } from './backendClient';

const command = process.argv[2];

type TemplateName = 'manual-receipt' | 'online-order-label' | 'test-label';

function requestedTemplate(): TemplateName {
  const arg = process.argv.slice(3).find((value) => value.startsWith('--template='));
  if (!arg) throw new Error('Missing --template=manual-receipt | --template=online-order-label | --template=test-label');
  const raw = arg.slice('--template='.length);
  if (raw === 'manual-receipt' || raw === 'online-order-label' || raw === 'test-label') return raw;
  throw new Error(`Unknown template: ${raw} (expected manual-receipt | online-order-label | test-label)`);
}

async function main(): Promise<void> {
  switch (command) {
    case 'printers:list': {
      const printers = await listPrinters();
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(printers, null, 2));
      return;
    }
    case 'bridge:dry-run': {
      const filePath = await renderJobPdf(sampleJob(requestedTemplate()));
      // eslint-disable-next-line no-console
      console.log(`Dry-run PDF written: ${filePath}`);
      return;
    }
    case 'print:test': {
      const job = sampleJob(requestedTemplate());
      const filePath = await renderJobPdf(job);
      await printPdf(filePath);
      // eslint-disable-next-line no-console
      console.log(
        bridgeEnv.PRINT_DRY_RUN
          ? `Dry-run ${requestedTemplate()} PDF written: ${filePath}`
          : `Sent ${requestedTemplate()} PDF to ${bridgeEnv.PRINTER_NAME}`,
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

function sampleJob(template: TemplateName): PrintJobDto {
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

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
