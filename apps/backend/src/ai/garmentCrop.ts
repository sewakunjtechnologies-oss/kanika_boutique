import sharp from 'sharp';
import { env } from '../config/env';
import { botError } from '../logger';
import { segmentGarmentOrOriginal } from './segmentation';

// Prepares the garment crop fed to the Gemini verifier:
//   QUERY image  → strip app/IG chrome → segment garment → confidence gate
//   CATALOG image → segment garment → confidence gate   (never UI-stripped)
// Everything degrades gracefully: a non-image / failure returns the original
// buffer and a neutral confidence, never throws.

const WHITE = { r: 255, g: 255, b: 255 };

export interface VerifierCrop {
  buffer: Buffer;
  /** 0..1 garment-isolation confidence; low → caller should abstain (NO MATCH). */
  confidence: number;
  stripped: boolean;
}

/**
 * Crop app/IG chrome out of a portrait phone SCREENSHOT (status bar at top, the
 * like/comment/share/DM action column on the right, the account/"Add comment" band
 * at the bottom). Position-zone based so it generalises across IG/app UI — it does
 * NOT key on any specific pixels. Returns null when the image isn't a portrait
 * screenshot, stripping is disabled, or anything fails (→ caller uses the original).
 */
export async function stripAppUi(buffer: Buffer): Promise<Buffer | null> {
  if (!env.IMAGE_STRIP_APP_UI) return null;
  try {
    const image = sharp(buffer, { failOn: 'none' }).rotate();
    const meta = await image.metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return null;
    // Only phone-screenshot-shaped portraits (~2.0:1+) carry full app chrome. Studio
    // product photos are milder portraits (~1.78); a high ratio avoids stripping those.
    const portrait = height / width;
    if (portrait < 1.9) return null;

    // Chrome zones (fractions). Conservative so the centred garment always survives.
    const top = Math.round(height * 0.06); // status bar + back/camera row
    const bottom = Math.round(height * 0.16); // account / Follow / "Add comment" bar
    const right = Math.round(width * 0.14); // heart/comment/share/DM action column
    const left = Math.round(width * 0.02);
    const cropW = width - left - right;
    const cropH = height - top - bottom;
    if (cropW < width * 0.5 || cropH < height * 0.5) return null;

    return await image
      .extract({ left, top, width: cropW, height: cropH })
      .jpeg({ quality: 92 })
      .toBuffer();
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'strip_app_ui' });
    return null;
  }
}

/**
 * Garment-isolation confidence in [0,1]. Conservative: returns a passing value when
 * it cannot measure (never abstains on uncertainty), and a low value only for a
 * clearly blank / featureless crop.
 */
export async function cropConfidence(buffer: Buffer): Promise<number> {
  try {
    const stats = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .flatten({ background: WHITE })
      .resize(64, 64, { fit: 'inside' })
      .toColourspace('srgb')
      .stats();
    const channels = stats.channels.slice(0, 3);
    if (channels.length === 0) return 1;
    const meanStdev = channels.reduce((sum, c) => sum + (c.stdev ?? 0), 0) / channels.length;
    // stdev ~0 → flat/blank crop; ~>30 → rich texture. Map to a soft confidence.
    return Math.max(0, Math.min(1, meanStdev / 30));
  } catch {
    return 1; // cannot measure → do not abstain
  }
}

/**
 * Full preprocess for one verifier image. `isQuery` enables app-UI stripping
 * (customer IG screenshots only). Never throws.
 */
export async function prepareVerifierCrop(buffer: Buffer, isQuery: boolean): Promise<VerifierCrop> {
  let working = buffer;
  let stripped = false;
  if (isQuery) {
    const ui = await stripAppUi(buffer);
    if (ui) {
      working = ui;
      stripped = true;
    }
  }
  const segmented = await segmentGarmentOrOriginal(working);
  const confidence = await cropConfidence(segmented);
  return { buffer: segmented, confidence, stripped };
}
