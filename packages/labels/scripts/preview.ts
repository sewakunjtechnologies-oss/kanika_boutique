// Generate preview/fixture PDFs for the 4x3_standard profile.
//
//   npx ts-node --transpile-only packages/labels/scripts/preview.ts
//
// Writes into <repo>/print-output:
//   * automated-order-label-96x68-preview.pdf
//   * manual-receipt-96x68-preview.pdf
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  countPdfPages,
  parseLabelPayload,
  parseOfflineCustomerSlipPayload,
  renderManualReceipt,
  renderOnlineOrderLabel,
  validateLabelPdfSize,
} from '../src';

const PROFILE = '4x3_standard' as const;
const OUT_DIR = path.resolve(__dirname, '../../../print-output');

async function emit(name: string, pdf: Buffer): Promise<void> {
  const validation = validateLabelPdfSize(pdf, PROFILE, 0.6);
  const pages = countPdfPages(pdf);
  if (!validation.ok) throw new Error(`${name}: PDF validation failed (${validation.reason ?? 'unknown'})`);
  if (pages !== 1) throw new Error(`${name}: expected 1 page, got ${pages}`);
  const filePath = path.join(OUT_DIR, name);
  await fs.writeFile(filePath, pdf);
  // eslint-disable-next-line no-console
  console.log(
    `wrote ${filePath} (${validation.actual?.widthPt.toFixed(1)}x${validation.actual?.heightPt.toFixed(1)}pt, rotate=${validation.rotation}, pages=${pages})`,
  );
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await emit(
    'automated-order-label-96x68-preview.pdf',
    await renderOnlineOrderLabel(
      parseLabelPayload({
        templateVersion: 'online-order-label-v1',
        storeName: 'Kanika Designs',
        orderId: 'KDA-2026-000123',
        customerName: 'Priya Sharma',
        maskedPhone: '98XXXXXX21',
        phoneMasked: '98XXXXXX21',
        productName: 'Blue Floral Pure Cotton Suit With Dupatta',
        sku: 'KD-PCS-101',
        size: '40',
        quantity: 2,
        amount: 4540,
        paymentStatus: 'PAID',
        paymentType: 'UPI',
        barcodeValue: 'KDA-2026-000123',
        addressLine1: 'H.No. 25, Sector 14',
        addressLine2: 'Near Main Market',
        city: 'Sonipat',
        state: 'Haryana',
        pincode: '131001',
        labelProfile: PROFILE,
      }),
      PROFILE,
    ),
  );
  await emit(
    'manual-receipt-96x68-preview.pdf',
    await renderManualReceipt(
      parseOfflineCustomerSlipPayload({
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
        labelProfile: PROFILE,
      }),
      PROFILE,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
