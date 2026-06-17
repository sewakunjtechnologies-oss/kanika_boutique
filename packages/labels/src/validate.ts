import zlib from 'node:zlib';
import { mmToPt, resolveLabelProfile } from './profiles';
import type { LabelProfileInput, LabelProfileName } from './profiles';

// Phase 6 — output validation: confirm a generated PDF's page size matches the
// selected profile, so a mis-sized label can never reach the printer silently.

export interface PdfSize {
  widthPt: number;
  heightPt: number;
}

/** Read the first /MediaBox from a PDF buffer. */
export function readPdfMediaBox(pdf: Buffer): PdfSize | null {
  const text = pdf.toString('latin1');
  const match = text.match(/\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/);
  if (!match) return null;
  const x0 = Number(match[1]);
  const y0 = Number(match[2]);
  const x1 = Number(match[3]);
  const y1 = Number(match[4]);
  return { widthPt: Math.abs(x1 - x0), heightPt: Math.abs(y1 - y0) };
}

export function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  return (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
}

/**
 * Extract the visible text drawn into a PDF by inflating its Flate content
 * streams and reading the strings inside Tj/TJ show operators. Used by tests to
 * assert which fields a template renders (e.g. the address row).
 */
export function extractPdfText(pdf: Buffer): string {
  const out: string[] = [];
  let index = 0;
  while (true) {
    const start = pdf.indexOf('stream', index);
    if (start === -1) break;
    // Skip the EOL after the `stream` keyword (\r\n or \n).
    let dataStart = start + 'stream'.length;
    if (pdf[dataStart] === 0x0d) dataStart += 1;
    if (pdf[dataStart] === 0x0a) dataStart += 1;
    const end = pdf.indexOf('endstream', dataStart);
    if (end === -1) break;
    const raw = pdf.subarray(dataStart, end);
    index = end + 'endstream'.length;
    let decoded: string;
    try {
      decoded = zlib.inflateSync(raw).toString('latin1');
    } catch {
      decoded = raw.toString('latin1');
    }
    // PDFKit shows text as hex strings inside TJ arrays, e.g. `[<4b41...> 0] TJ`.
    for (const tj of decoded.matchAll(/\[([^\]]*)\]\s*TJ/g)) {
      let line = '';
      for (const hex of (tj[1] ?? '').matchAll(/<([0-9a-fA-F]*)>/g)) {
        line += hexToLatin1(hex[1] ?? '');
      }
      if (line) out.push(line);
    }
    // Also handle plain `(text) Tj` strings if any renderer emits them.
    for (const match of decoded.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
      out.push((match[1] ?? '').replace(/\\([()\\])/g, '$1'));
    }
  }
  return out.join('\n');
}

function hexToLatin1(hex: string): string {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) {
    s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return s;
}

export function readPdfRotation(pdf: Buffer): number {
  const text = pdf.toString('latin1');
  const match = text.match(/\/Rotate\s+(-?\d+)/);
  return match ? Number(match[1]) : 0;
}

export interface LabelSizeValidation {
  ok: boolean;
  profile: LabelProfileName;
  expected: PdfSize;
  actual: PdfSize | null;
  rotation: number;
  reason?: string;
}

/**
 * Validate that a rendered label PDF matches the expected profile page size
 * within a small tolerance (sub-point rounding from mm→pt conversion).
 */
export function validateLabelPdfSize(
  pdf: Buffer,
  profileName: LabelProfileInput,
  tolerancePt = 1,
): LabelSizeValidation {
  const profile = resolveLabelProfile(profileName);
  const normalizedProfileName = profile.name;
  const expected: PdfSize = {
    widthPt: mmToPt(profile.widthMm),
    heightPt: mmToPt(profile.heightMm),
  };
  const actual = readPdfMediaBox(pdf);
  const rotation = readPdfRotation(pdf);
  if (!actual) {
    return { ok: false, profile: normalizedProfileName, expected, actual: null, rotation, reason: 'no MediaBox found' };
  }
  const widthOk = Math.abs(actual.widthPt - expected.widthPt) <= tolerancePt;
  const heightOk = Math.abs(actual.heightPt - expected.heightPt) <= tolerancePt;
  return {
    ok: widthOk && heightOk && rotation === 0,
    profile: normalizedProfileName,
    expected,
    actual,
    rotation,
    ...(widthOk && heightOk && rotation === 0 ? {} : { reason: rotation === 0 ? 'page size mismatch' : 'page rotation present' }),
  };
}
