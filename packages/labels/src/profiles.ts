// Physical label profiles used by the Windows print bridge. The current live
// stock is 4x3 landscape; 4x4 portrait is future-ready and opt-in by config.

export type LabelProfileName = '4x3_landscape' | '4x4_portrait';
export type LegacyLabelProfileName = '4x3' | '4x4';
export type AnyLabelProfileName = LabelProfileName | LegacyLabelProfileName;

export interface LabelProfile {
  name: LabelProfileName;
  orientation: 'landscape' | 'portrait';
  /** Physical label width in millimetres. */
  widthMm: number;
  /** Physical label height in millimetres. */
  heightMm: number;
  /** Printable safe-area width inside the physical margins. */
  safeWidthMm: number;
  /** Printable safe-area height inside the physical margins. */
  safeHeightMm: number;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  /** Visual Code-128 barcode height. */
  barcodeHeightMm: number;
  /** Total reserved barcode section including human-readable order id. */
  barcodeAreaHeightMm: number;
  /** Windows custom paper/form name to select when supported by the print library. */
  paperSizeName: string;
}

export const LABEL_PROFILES: Record<LabelProfileName, LabelProfile> = {
  '4x3_landscape': {
    name: '4x3_landscape',
    orientation: 'landscape',
    widthMm: 101.6,
    heightMm: 76.2,
    safeWidthMm: 95,
    safeHeightMm: 68,
    marginTopMm: 2.5,
    marginRightMm: 3,
    marginBottomMm: 4.5,
    marginLeftMm: 3,
    barcodeHeightMm: 9,
    barcodeAreaHeightMm: 13,
    paperSizeName: 'Kanika-4x3',
  },
  '4x4_portrait': {
    name: '4x4_portrait',
    orientation: 'portrait',
    widthMm: 101.6,
    heightMm: 101.6,
    safeWidthMm: 95,
    safeHeightMm: 94,
    marginTopMm: 3,
    marginRightMm: 3,
    marginBottomMm: 5,
    marginLeftMm: 3,
    barcodeHeightMm: 11,
    barcodeAreaHeightMm: 16,
    paperSizeName: 'Kanika-4x4',
  },
};

export const DEFAULT_LABEL_PROFILE: LabelProfileName = '4x3_landscape';

export function normalizeLabelProfileName(name: string | undefined | null): LabelProfileName {
  if (name === '4x4' || name === '4x4_portrait') return '4x4_portrait';
  return '4x3_landscape';
}

export function resolveLabelProfile(name: string | undefined | null): LabelProfile {
  return LABEL_PROFILES[normalizeLabelProfileName(name)];
}

/** PDF user-space units are points (1/72 inch). Convert millimetres → points. */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

/** Printer dot resolution. DCode DC421 Pro is a 203 DPI printer. */
export const PRINTER_DPI = 203;

/** Convert millimetres → printer dots at the given DPI (default 203). */
export function mmToDots(mm: number, dpi: number = PRINTER_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}
