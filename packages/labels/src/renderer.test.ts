import { describe, expect, test } from 'vitest';
import {
  TESTED_LABEL_CSS_4X3,
  compactAddress,
  renderCode128BarcodeSvg,
  renderOnlineOrderHtml,
  renderOnlineOrderLabel,
  testedLabelCss,
} from './renderer';
import { parseLabelPayload } from './payload';

const payload = parseLabelPayload({
  templateVersion: 'online-order-label-v1',
  storeName: 'KANIKA DESIGNS',
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
});

describe('tested HTML label renderer', () => {
  test('4x3 CSS remains the exact manually tested geometry', () => {
    expect(testedLabelCss('4x3')).toBe(TESTED_LABEL_CSS_4X3);
    expect(TESTED_LABEL_CSS_4X3).toContain('@page {\n  size: 101.6mm 76.2mm;\n  margin: 0;\n}');
    expect(TESTED_LABEL_CSS_4X3).toContain('width: 101.6mm;');
    expect(TESTED_LABEL_CSS_4X3).toContain('height: 76.2mm;');
    expect(TESTED_LABEL_CSS_4X3).toContain('padding: 2.5mm 3mm 4mm;');
    expect(TESTED_LABEL_CSS_4X3).toContain('width: 86mm;');
    expect(TESTED_LABEL_CSS_4X3).toContain('height: 9mm;');
    expect(TESTED_LABEL_CSS_4X3).not.toContain('transform');
  });

  test('4x4 changes only the page/element height from the tested 4x3 CSS', () => {
    const css = testedLabelCss('4x4');
    expect(css).toContain('size: 101.6mm 101.6mm;');
    expect(css).toContain('width: 101.6mm;');
    expect(css).toContain('height: 101.6mm;');
    expect(css).toContain('padding: 2.5mm 3mm 4mm;');
    expect(css).toContain('width: 86mm;');
    expect(css).toContain('height: 9mm;');
    expect(css).not.toContain('height: 76.2mm;');
  });

  test('online order HTML includes address fields and the exact tested CSS', async () => {
    const html = await renderOnlineOrderHtml(payload, '4x3');
    expect(html).toContain(TESTED_LABEL_CSS_4X3);
    expect(html).toContain('<strong>Pincode:</strong> 131001');
    expect(html).toContain('<strong>Address:</strong> H.No. 25, Sector 14, Near Main Market, Sonipat, Haryana');
    expect(html).toContain('<strong>Product:</strong> Pure Cotton Suit With Long Name');
    expect(html).toContain('<div class="paid">PAID</div>');
    expect(html).toContain('<div class="barcode-text">KD-TEST-1001</div>');
  });

  test('online order renderer alias uses the same tested HTML body', async () => {
    await expect(renderOnlineOrderLabel(payload, '4x3')).resolves.toBe(await renderOnlineOrderHtml(payload, '4x3'));
  });

  test('compact address falls back without adding layout-specific placeholders', () => {
    expect(compactAddress({})).toBe('Not provided');
    expect(compactAddress({ addressLine1: 'A', addressLine2: '', city: 'B', state: 'C' })).toBe('A, B, C');
  });

  test('barcode is generated locally with the CSS-controlled barcode element', async () => {
    const svg = await renderCode128BarcodeSvg('KD-TEST-1001');
    expect(svg).toContain('<svg id="barcode"');
    expect(svg).toContain('viewBox=');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('cdn');
  });
});
