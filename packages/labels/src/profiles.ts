// Physical label profiles used by the Windows print bridge.
//
// Two coordinate systems matter here:
//   * The PHYSICAL page (widthMm x heightMm) is the PDF MediaBox the printer
//     receives. Its /Rotate metadata is always 0 and Windows always prints it
//     "Portrait / Normal" at 100% with no fit and no driver auto-rotation.
//   * The LOGICAL design canvas (designWidthMm x designHeightMm) is where the
//     renderer lays out the label. `compact_96x68` uses a 96 x 68 mm logical
//     canvas centered inside the physical 101.6 x 76.2 mm 4x3 stock.

export type LabelProfileName = 'compact_96x68' | '4x3' | '4x4_portrait';
export type LegacyLabelProfileName = '4x3_landscape' | '4x4';
export type AnyLabelProfileName = LabelProfileName | LegacyLabelProfileName;

export interface LabelProfile {
  name: LabelProfileName;
  orientation: 'portrait';
  /** PDF page /Rotate metadata. Always 0 — never let the PDF carry rotation. */
  rotation: 0;
  /** Renderer-side rotation. Always 0 for the 4BARCODE profile. */
  rendererRotation: 0;
  /** Physical label width in millimetres (PDF MediaBox width). */
  widthMm: number;
  /** Physical label height in millimetres (PDF MediaBox height). */
  heightMm: number;
  /** Logical design-canvas width in millimetres (where content is laid out). */
  designWidthMm: number;
  /** Logical design-canvas height in millimetres (where content is laid out). */
  designHeightMm: number;
  /** Printable safe-area width inside the logical design canvas margins. */
  safeWidthMm: number;
  /** Printable safe-area height inside the logical design canvas margins. */
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
  'compact_96x68': {
    name: 'compact_96x68',
    orientation: 'portrait',
    rotation: 0,
    rendererRotation: 0,
    widthMm: 101.6,
    heightMm: 76.2,
    designWidthMm: 96,
    designHeightMm: 68,
    safeWidthMm: 96,
    safeHeightMm: 68,
    marginTopMm: 0,
    marginRightMm: 0,
    marginBottomMm: 0,
    marginLeftMm: 0,
    barcodeHeightMm: 9,
    barcodeAreaHeightMm: 13,
    paperSizeName: 'Kanika-4x3',
  },
  '4x3': {
    name: '4x3',
    orientation: 'portrait',
    rotation: 0,
    rendererRotation: 0,
    widthMm: 101.6,
    heightMm: 76.2,
    designWidthMm: 101.6,
    designHeightMm: 76.2,
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
    rotation: 0,
    rendererRotation: 0,
    widthMm: 101.6,
    heightMm: 101.6,
    designWidthMm: 101.6,
    designHeightMm: 101.6,
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

export const DEFAULT_LABEL_PROFILE: LabelProfileName = 'compact_96x68';

export function normalizeLabelProfileName(name: string | undefined | null): LabelProfileName {
  if (name === '4x4' || name === '4x4_portrait') return '4x4_portrait';
  if (name === '4x3' || name === '4x3_landscape' || name === 'compact_96x68' || !name) return 'compact_96x68';
  return 'compact_96x68';
}

export type LabelProfileInput = AnyLabelProfileName | LabelProfile;

export interface LabelProfileOverrides {
  widthMm?: number;
  heightMm?: number;
  designWidthMm?: number;
  designHeightMm?: number;
  orientation?: 'portrait';
  rotation?: 0;
}

export function resolveLabelProfile(
  nameOrProfile: LabelProfileInput | undefined | null,
  overrides: LabelProfileOverrides = {},
): LabelProfile {
  const base =
    typeof nameOrProfile === 'object' && nameOrProfile
      ? nameOrProfile
      : LABEL_PROFILES[normalizeLabelProfileName(nameOrProfile)];
  return {
    ...base,
    ...overrides,
    name: base.name,
    // No rotation is carried by the PDF or renderer for the current 4BARCODE
    // media profile.
    rotation: 0,
    rendererRotation: 0,
  };
}

export interface ContentBox {
  offsetXmm: number;
  offsetYmm: number;
  widthMm: number;
  heightMm: number;
}

export function getContentBox(profileInput: LabelProfileInput | undefined | null): ContentBox {
  const profile = resolveLabelProfile(profileInput);
  return {
    offsetXmm: (profile.widthMm - profile.designWidthMm) / 2,
    offsetYmm: (profile.heightMm - profile.designHeightMm) / 2,
    widthMm: profile.designWidthMm,
    heightMm: profile.designHeightMm,
  };
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
