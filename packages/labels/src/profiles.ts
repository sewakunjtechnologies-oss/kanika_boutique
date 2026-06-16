// Label profiles (Phase 11). The current sample roll is 4x3; the future
// permanent roll is 4x4. The same template renders both — only the profile
// (page size + safe area) changes, selected by env in the bridge/backend.

export type LabelProfileName = '4x3' | '4x4';

export interface LabelProfile {
  name: LabelProfileName;
  /** Physical label width in millimetres. */
  widthMm: number;
  /** Physical label height in millimetres. */
  heightMm: number;
  /** Printable content width inside the physical margins. */
  contentWidthMm: number;
  /** Printable content height inside the physical margins. */
  contentHeightMm: number;
  marginTopMm: number;
  marginRightMm: number;
  marginBottomMm: number;
  marginLeftMm: number;
  /** Visual Code-128 barcode height. */
  barcodeHeightMm: number;
  /** Total reserved barcode section including human-readable order id. */
  barcodeAreaHeightMm: number;
}

export const LABEL_PROFILES: Record<LabelProfileName, LabelProfile> = {
  '4x3': {
    name: '4x3',
    widthMm: 101.6,
    heightMm: 76.2,
    contentWidthMm: 95.6,
    contentHeightMm: 68.5,
    marginTopMm: 2.5,
    marginRightMm: 3,
    marginBottomMm: 5.2,
    marginLeftMm: 3,
    barcodeHeightMm: 9,
    barcodeAreaHeightMm: 13,
  },
  '4x4': {
    name: '4x4',
    widthMm: 101.6,
    heightMm: 101.6,
    contentWidthMm: 95.6,
    contentHeightMm: 94,
    marginTopMm: 2.5,
    marginRightMm: 3,
    marginBottomMm: 5.1,
    marginLeftMm: 3,
    barcodeHeightMm: 11,
    barcodeAreaHeightMm: 16,
  },
};

export function resolveLabelProfile(name: string | undefined | null): LabelProfile {
  if (name === '4x4') return LABEL_PROFILES['4x4'];
  return LABEL_PROFILES['4x3'];
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
