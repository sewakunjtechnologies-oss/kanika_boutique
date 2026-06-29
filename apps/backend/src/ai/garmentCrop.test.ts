import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import sharp from 'sharp';
import { env } from '../config/env';
import { __setSegmenterForTests, clearSegmentationCache } from './segmentation';
import { cropConfidence, prepareVerifierCrop, stripAppUi } from './garmentCrop';

// Build a checkerboard-ish textured image (non-blank) at a given size.
async function textured(width: number, height: number): Promise<Buffer> {
  const channels = 3;
  const data = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const i = (y * width + x) * channels;
      data[i] = on ? 20 : 200;
      data[i + 1] = on ? 40 : 180;
      data[i + 2] = on ? 60 : 160;
    }
  }
  return sharp(data, { raw: { width, height, channels } }).jpeg().toBuffer();
}

async function blank(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
}

async function dims(buffer: Buffer): Promise<{ w: number; h: number }> {
  const m = await sharp(buffer).metadata();
  return { w: m.width ?? 0, h: m.height ?? 0 };
}

beforeEach(() => {
  clearSegmentationCache();
  __setSegmenterForTests(null);
  env.IMAGE_STRIP_APP_UI = true;
  env.IMAGE_SEGMENTATION_ENABLED = false;
  env.IMAGE_CROP_MIN_CONFIDENCE = 0.35;
});
afterEach(() => {
  __setSegmenterForTests(null);
  clearSegmentationCache();
  env.IMAGE_SEGMENTATION_ENABLED = false;
  env.IMAGE_STRIP_APP_UI = true;
});

describe('stripAppUi — remove phone/IG chrome from a portrait screenshot', () => {
  test('tall phone screenshot (2.17:1) → chrome zones cropped (smaller frame)', async () => {
    const out = await stripAppUi(await textured(590, 1280));
    expect(out).not.toBeNull();
    const { w, h } = await dims(out!);
    expect(w).toBeLessThan(590); // right action column + left margin removed
    expect(h).toBeLessThan(1280); // status bar + comment bar removed
    expect(w).toBeGreaterThan(590 * 0.5);
    expect(h).toBeGreaterThan(1280 * 0.5);
  });

  test('studio-ratio portrait (1.78:1) is NOT stripped (avoids cutting product photos)', async () => {
    expect(await stripAppUi(await textured(1206, 2144))).toBeNull();
  });

  test('square / landscape is NOT stripped', async () => {
    expect(await stripAppUi(await textured(1000, 1000))).toBeNull();
    expect(await stripAppUi(await textured(1280, 720))).toBeNull();
  });

  test('disabled flag → null', async () => {
    env.IMAGE_STRIP_APP_UI = false;
    expect(await stripAppUi(await textured(590, 1280))).toBeNull();
  });

  test('non-image buffer → null (graceful, no throw)', async () => {
    expect(await stripAppUi(Buffer.from('not-an-image'))).toBeNull();
  });
});

describe('cropConfidence — abstain on blank crops', () => {
  test('blank crop → low confidence (below default gate)', async () => {
    expect(await cropConfidence(await blank(256, 256))).toBeLessThan(0.35);
  });
  test('textured garment crop → high confidence', async () => {
    expect(await cropConfidence(await textured(256, 256))).toBeGreaterThan(0.35);
  });
  test('non-image → 1 (cannot measure → never abstain)', async () => {
    expect(await cropConfidence(Buffer.from('x'))).toBe(1);
  });
});

describe('prepareVerifierCrop', () => {
  test('query screenshot is UI-stripped then (no-op) segmented; confidence reported', async () => {
    const r = await prepareVerifierCrop(await textured(590, 1280), true);
    expect(r.stripped).toBe(true);
    expect(r.confidence).toBeGreaterThan(0.35);
    const { w } = await dims(r.buffer);
    expect(w).toBeLessThan(590);
  });

  test('catalog image is NEVER UI-stripped (only segmented)', async () => {
    const original = await textured(590, 1280);
    const r = await prepareVerifierCrop(original, false);
    expect(r.stripped).toBe(false);
  });

  test('segmentation ON → crop is the segmented buffer', async () => {
    env.IMAGE_SEGMENTATION_ENABLED = true;
    const marker = await textured(300, 300);
    __setSegmenterForTests(async () => marker);
    const r = await prepareVerifierCrop(await textured(1000, 1000), false);
    expect(r.buffer).toBe(marker);
  });

  test('blank query → low confidence (caller abstains → NO MATCH)', async () => {
    const r = await prepareVerifierCrop(await blank(590, 1280), true);
    expect(r.confidence).toBeLessThan(0.35);
  });
});
