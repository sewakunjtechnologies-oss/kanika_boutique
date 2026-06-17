// Physical label profiles used by the Windows print bridge.
//
// There is ONE coordinate system: the physical 101.6 x 76.2 mm page is also the
// design canvas. The renderer lays content out directly on the full page with
// the tested HTML padding (2.5mm top, 3mm sides, 4mm bottom). There is no 96x68
// centered canvas, no rotation and no width/height swap — the PDF MediaBox is
// 101.6 x 76.2 mm, /Rotate is always 0, and Windows prints "Portrait / Normal"
// at 100% with no fit and no driver auto-rotation.

export type LabelProfileName = '4x3_standard';
export type LegacyLabelProfileName = 'compact_96x68' | '4x3' | '4x3_landscape' | '4x4' | '4x4_portrait';
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
  physicalWidthMm: number;
  physicalHeightMm: number;
  contentWidthMm: number;
  contentHeightMm: number;
  offsetXmm: number;
  offsetYmm: number;
  pdfRotation: 0;
  windowsOrientation: 'portrait';
  windowsRotation: 0;
  scaleMode: 'noscale';
}

export const LABEL_PROFILES: Record<LabelProfileName, LabelProfile> = {
  '4x3_standard': {
    name: '4x3_standard',
    orientation: 'portrait',
    rotation: 0,
    rendererRotation: 0,
    widthMm: 101.6,
    heightMm: 76.2,
    designWidthMm: 101.6,
    designHeightMm: 76.2,
    safeWidthMm: 95.6,
    safeHeightMm: 69.7,
    marginTopMm: 2.5,
    marginRightMm: 3,
    marginBottomMm: 4,
    marginLeftMm: 3,
    barcodeHeightMm: 9,
    barcodeAreaHeightMm: 13,
    paperSizeName: 'Kanika-4x3',
    physicalWidthMm: 101.6,
    physicalHeightMm: 76.2,
    contentWidthMm: 101.6,
    contentHeightMm: 76.2,
    offsetXmm: 0,
    offsetYmm: 0,
    pdfRotation: 0,
    windowsOrientation: 'portrait',
    windowsRotation: 0,
    scaleMode: 'noscale',
  },
};

export const DEFAULT_LABEL_PROFILE: LabelProfileName = '4x3_standard';

export function normalizeLabelProfileName(name: string | undefined | null): LabelProfileName {
  void name;
  return '4x3_standard';
}

export type LabelProfileInput = AnyLabelProfileName | LabelProfile;

export interface LabelProfileOverrides {
  widthMm?: number;
  heightMm?: number;
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
  const widthMm = overrides.widthMm ?? base.widthMm;
  const heightMm = overrides.heightMm ?? base.heightMm;
  const designWidthMm = base.designWidthMm;
  const designHeightMm = base.designHeightMm;
  return {
    ...base,
    ...overrides,
    name: base.name,
    widthMm,
    heightMm,
    physicalWidthMm: widthMm,
    physicalHeightMm: heightMm,
    designWidthMm,
    designHeightMm,
    contentWidthMm: designWidthMm,
    contentHeightMm: designHeightMm,
    offsetXmm: roundMm((widthMm - designWidthMm) / 2),
    offsetYmm: roundMm((heightMm - designHeightMm) / 2),
    // No rotation is carried by the PDF or renderer for the current 4BARCODE
    // media profile.
    rotation: 0,
    rendererRotation: 0,
    pdfRotation: 0,
    windowsOrientation: 'portrait',
    windowsRotation: 0,
    scaleMode: 'noscale',
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
    offsetXmm: profile.offsetXmm,
    offsetYmm: profile.offsetYmm,
    widthMm: profile.contentWidthMm,
    heightMm: profile.contentHeightMm,
  };
}

/** PDF user-space units are points (1/72 inch). Convert millimetres → points. */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}

function roundMm(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Printer dot resolution. DCode DC421 Pro is a 203 DPI printer. */
export const PRINTER_DPI = 203;

/** Convert millimetres → printer dots at the given DPI (default 203). */
export function mmToDots(mm: number, dpi: number = PRINTER_DPI): number {
  return Math.round((mm / 25.4) * dpi);
}
