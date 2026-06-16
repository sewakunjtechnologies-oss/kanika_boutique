// Generate preview/fixture PDFs for the 4x3_portrait_rotated label profile.
//
//   npx ts-node --transpile-only packages/labels/scripts/preview.ts
//
// Writes into <repo>/print-output:
//   * preview-4x3-portrait-rotated.pdf   — representative label
//   * fixture-4x3-portrait-long-address.pdf
//   * fixture-4x3-portrait-long-product.pdf
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseLabelPayload, renderOrderLabel, validateLabelPdfSize, countPdfPages } from '../src';

const PROFILE = '4x3_portrait_rotated' as const;
const OUT_DIR = path.resolve(__dirname, '../../../print-output');

const base = {
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
};

const longAddress = {
  ...base,
  orderId: 'KDA-2026-000124',
  barcodeValue: 'KDA-2026-000124',
  addressLine1: 'House No. 1234, Third Floor, Above State Bank Of India Branch',
  addressLine2: 'Opposite The Very Large And Famous Community Market Gate Number Seven',
  city: 'Greater Noida West Extension Township',
  state: 'Uttar Pradesh',
  pincode: '201318',
};

const longProduct = {
  ...base,
  orderId: 'KDA-2026-000125',
  barcodeValue: 'KDA-2026-000125',
  productName:
    'Premium Hand Embroidered Pure Banarasi Silk Anarkali Suit Set With Heavy Dupatta And Matching Bottom Extra Long Title',
  sku: 'KD-PREMIUM-BANARASI-ANARKALI-XXL-EDITION-0001',
};

async function emit(name: string, raw: typeof base): Promise<void> {
  const payload = parseLabelPayload(raw);
  const pdf = await renderOrderLabel(payload, PROFILE);
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
  await emit('preview-4x3-portrait-rotated.pdf', base);
  await emit('fixture-4x3-portrait-long-address.pdf', longAddress);
  await emit('fixture-4x3-portrait-long-product.pdf', longProduct);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
