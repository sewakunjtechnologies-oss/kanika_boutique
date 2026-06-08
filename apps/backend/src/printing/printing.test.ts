import { describe, expect, test } from 'vitest';
import { createTextPdf } from './pdfDocument';
import { isPrintNodeReady } from './printNodeClient';

describe('PDF print fallback', () => {
  test('creates a downloadable PDF buffer', () => {
    const pdf = createTextPdf(['Kanika Designs', 'Receipt MR-1', 'Total Rs 250']);
    expect(pdf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(pdf.toString('utf8')).toContain('%%EOF');
  });

  test('missing PrintNode printer id keeps printing in manual fallback mode', () => {
    expect(
      isPrintNodeReady({
        PRINT_PROVIDER: 'printnode',
        PRINTNODE_API_KEY: 'api-key',
        printerId: '',
      }),
    ).toBe(false);
  });

  test('manual provider never tries PrintNode even if credentials exist', () => {
    expect(
      isPrintNodeReady({
        PRINT_PROVIDER: 'manual',
        PRINTNODE_API_KEY: 'api-key',
        printerId: '123',
      }),
    ).toBe(false);
  });
});
