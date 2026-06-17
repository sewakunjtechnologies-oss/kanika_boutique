export type LabelSizeName = '4x3' | '4x4';

export interface LabelSizeSpec {
  name: LabelSizeName;
  widthMm: number;
  heightMm: number;
}

export const LABEL_SIZES: Record<LabelSizeName, LabelSizeSpec> = {
  '4x3': { name: '4x3', widthMm: 101.6, heightMm: 76.2 },
  '4x4': { name: '4x4', widthMm: 101.6, heightMm: 101.6 },
};

export const DEFAULT_LABEL_SIZE: LabelSizeName = '4x3';

export function resolveLabelSize(size: string | undefined | null = DEFAULT_LABEL_SIZE): LabelSizeSpec {
  return size === '4x4' ? LABEL_SIZES['4x4'] : LABEL_SIZES['4x3'];
}

export type LabelSizeInput = LabelSizeName | LabelSizeSpec;

export function resolveLabelSizeInput(size: LabelSizeInput | undefined | null = DEFAULT_LABEL_SIZE): LabelSizeSpec {
  if (typeof size === 'object' && size) return size;
  return resolveLabelSize(size);
}

/** PDF user-space units are points (1/72 inch). Convert millimetres to points. */
export function mmToPt(mm: number): number {
  return (mm * 72) / 25.4;
}
