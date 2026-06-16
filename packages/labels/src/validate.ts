import { LABEL_PROFILES, mmToPt, normalizeLabelProfileName } from './profiles';
import type { AnyLabelProfileName, LabelProfileName } from './profiles';

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

export interface LabelSizeValidation {
  ok: boolean;
  profile: LabelProfileName;
  expected: PdfSize;
  actual: PdfSize | null;
  reason?: string;
}

/**
 * Validate that a rendered label PDF matches the expected profile page size
 * within a small tolerance (sub-point rounding from mm→pt conversion).
 */
export function validateLabelPdfSize(
  pdf: Buffer,
  profileName: AnyLabelProfileName,
  tolerancePt = 1,
): LabelSizeValidation {
  const normalizedProfileName = normalizeLabelProfileName(profileName);
  const profile = LABEL_PROFILES[normalizedProfileName];
  const expected: PdfSize = {
    widthPt: mmToPt(profile.widthMm),
    heightPt: mmToPt(profile.heightMm),
  };
  const actual = readPdfMediaBox(pdf);
  if (!actual) {
    return { ok: false, profile: normalizedProfileName, expected, actual: null, reason: 'no MediaBox found' };
  }
  const widthOk = Math.abs(actual.widthPt - expected.widthPt) <= tolerancePt;
  const heightOk = Math.abs(actual.heightPt - expected.heightPt) <= tolerancePt;
  return {
    ok: widthOk && heightOk,
    profile: normalizedProfileName,
    expected,
    actual,
    ...(widthOk && heightOk ? {} : { reason: 'page size mismatch' }),
  };
}
