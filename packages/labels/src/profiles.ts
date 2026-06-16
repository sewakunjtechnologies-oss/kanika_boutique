// Physical label profiles used by the Windows print bridge.
//
// Two coordinate systems matter here:
//   * The PHYSICAL page (widthMm x heightMm) is the PDF MediaBox the printer
//     receives. Its /Rotate metadata is always 0 and Windows always prints it
//     "Portrait / Normal" at 100% with no fit and no driver auto-rotation.
//   * The LOGICAL design canvas (designWidthMm x designHeightMm) is where the
//     renderer lays out the label. For most profiles the logical canvas equals
//     the physical page. For `4x3_portrait_rotated` the logical canvas is a
//     PORTRAIT 76.2 x 101.6 sheet that the renderer rotates exactly once (90
//     degrees) so it fits the wider-than-tall physical 4x3 stock. This keeps a
//     single rotation layer in the renderer and zero rotation everywhere else.

export type LabelProfileName = '4x3' | '4x4_portrait' | '4x3_portrait_rotated';
export type LegacyLabelProfileName = '4x3_landscape' | '4x4';
export type AnyLabelProfileName = LabelProfileName | LegacyLabelProfileName;

export interface LabelProfile {
  name: LabelProfileName;
  orientation: 'portrait';
  /** PDF page /Rotate metadata. Always 0 — never let the PDF carry rotation. */
  rotation: 0;
  /**
   * Rotation the RENDERER applies to the logical design canvas before placing
   * it on the physical page. 0 means the logical canvas is drawn 1:1 on the
   * physical page; 90 means a portrait logical canvas is rotated a quarter turn
   * to fit a landscape physical page. This is the only place rotation happens.
   */
  rendererRotation: 0 | 90;
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
  // Portrait-style design printed on the physical 4x3 (landscape) stock.
  // Physical page: 101.6 x 76.2 mm, /Rotate 0. Logical canvas: 76.2 x 101.6 mm
  // (portrait). The renderer rotates the logical canvas exactly 90 degrees onto
  // the physical page; Windows still prints Portrait / Normal at 100%.
  '4x3_portrait_rotated': {
    name: '4x3_portrait_rotated',
    orientation: 'portrait',
    rotation: 0,
    rendererRotation: 90,
    widthMm: 101.6,
    heightMm: 76.2,
    designWidthMm: 76.2,
    designHeightMm: 101.6,
    safeWidthMm: 70,
    safeHeightMm: 94,
    marginTopMm: 3,
    marginRightMm: 3,
    marginBottomMm: 4.5,
    marginLeftMm: 3,
    barcodeHeightMm: 11,
    barcodeAreaHeightMm: 16,
    paperSizeName: 'Kanika-4x3',
  },
};

export const DEFAULT_LABEL_PROFILE: LabelProfileName = '4x3';

export function normalizeLabelProfileName(name: string | undefined | null): LabelProfileName {
  if (name === '4x4' || name === '4x4_portrait') return '4x4_portrait';
  if (name === '4x3_portrait_rotated') return '4x3_portrait_rotated';
  return '4x3';
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
    // PDF metadata rotation is never carried by the page. The renderer is the
    // single source of geometric rotation (base.rendererRotation).
    rotation: 0,
    rendererRotation: base.rendererRotation,
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
