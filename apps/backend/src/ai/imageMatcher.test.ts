import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { env } from '../config/env';
import { classifyImageMatchDecision } from './productMatcher';
import { inspectImageBuffer, rankImageMatches, type ImageCandidate } from './imageMatcher';

function garmentSvg({
  main = '#2b6cb0',
  accent = '#f6d365',
  embroidery = '#e53e3e',
}: {
  main?: string;
  accent?: string;
  embroidery?: string;
}): Buffer {
  return Buffer.from(`
    <svg width="360" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#fff"/>
      <path d="M170 35 C130 60 105 140 92 245 L76 430 H284 L268 245 C255 140 230 60 190 35 Z" fill="${main}"/>
      <path d="M145 56 L215 56 L235 430 L125 430 Z" fill="${accent}" opacity="0.45"/>
      <path d="M105 120 C152 145 211 145 255 120" stroke="${embroidery}" stroke-width="12" fill="none"/>
      <path d="M120 205 C160 226 205 226 242 205" stroke="${embroidery}" stroke-width="10" fill="none"/>
      <circle cx="150" cy="292" r="14" fill="${embroidery}"/>
      <circle cx="210" cy="292" r="14" fill="${embroidery}"/>
      <path d="M152 355 L208 355" stroke="#111" stroke-width="8"/>
    </svg>
  `);
}

function unrelatedSvg(): Buffer {
  return Buffer.from(`
    <svg width="360" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#f7fafc"/>
      <rect x="35" y="50" width="290" height="380" rx="20" fill="#1a202c"/>
      <circle cx="180" cy="170" r="80" fill="#38a169"/>
      <rect x="90" y="300" width="180" height="55" fill="#faf089"/>
      <path d="M70 80 L290 420" stroke="#e53e3e" stroke-width="18"/>
    </svg>
  `);
}

function differentEmbroiderySvg({
  main = '#be123c',
  accent = '#fecdd3',
  embroidery = '#facc15',
}: {
  main?: string;
  accent?: string;
  embroidery?: string;
}): Buffer {
  return Buffer.from(`
    <svg width="360" height="480" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#fff"/>
      <path d="M165 34 C118 82 100 160 96 250 L88 430 H272 L264 250 C260 160 232 82 195 34 Z" fill="${main}"/>
      <path d="M156 62 L204 62 L218 430 L142 430 Z" fill="${accent}" opacity="0.45"/>
      <path d="M120 115 L240 190 M240 115 L120 190 M118 248 L242 320 M242 248 L118 320" stroke="${embroidery}" stroke-width="10" fill="none"/>
      <circle cx="140" cy="360" r="10" fill="${embroidery}"/>
      <circle cx="180" cy="382" r="10" fill="${embroidery}"/>
      <circle cx="220" cy="360" r="10" fill="${embroidery}"/>
      <path d="M150 92 C168 118 192 118 210 92" stroke="#111" stroke-width="8" fill="none"/>
    </svg>
  `);
}

async function jpg(input: Buffer, quality = 85): Promise<Buffer> {
  return sharp(input).jpeg({ quality }).toBuffer();
}

async function screenshotLike(input: Buffer): Promise<Buffer> {
  const resized = await sharp(input).resize(300, 400, { fit: 'contain', background: '#ffffff' }).png().toBuffer();
  return sharp({
    create: { width: 390, height: 520, channels: 3, background: '#f8fafc' },
  })
    .composite([{ input: resized, left: 45, top: 60 }])
    .jpeg({ quality: 82 })
    .toBuffer();
}

function candidate(productId: string, imageBuffer: Buffer, sku = productId): ImageCandidate {
  return {
    productId,
    sku,
    name: `Product ${sku}`,
    imageUrl: `https://cdn.test/${sku}.jpg`,
    imageBuffer,
  };
}

describe('imageMatcher controlled inventory-photo matrix', () => {
  test('exact original inventory file returns an exact match with confidence 1', async () => {
    const inventory = await jpg(garmentSvg({}));
    const scores = await rankImageMatches(inventory, [
      candidate('blue-suit', inventory, 'KD-104'),
      candidate('unrelated-item', await jpg(unrelatedSvg()), 'KD-999'),
    ]);

    expect(scores[0]?.productId).toBe('blue-suit');
    expect(scores[0]?.matchType).toBe('EXACT_MATCH');
    expect(scores[0]?.confidence).toBe(1);
  });

  test('WhatsApp-like JPEG compression becomes a near-duplicate, not a generic colour match', async () => {
    const inventory = await jpg(garmentSvg({}));
    const compressed = await jpg(inventory, 42);
    const scores = await rankImageMatches(compressed, [
      candidate('blue-suit', inventory, 'KD-104'),
      candidate('unrelated-item', await jpg(unrelatedSvg()), 'KD-999'),
    ]);

    expect(scores[0]?.productId).toBe('blue-suit');
    expect(scores[0]?.matchType).toBe('NEAR_DUPLICATE_MATCH');
    expect(scores[0]?.confidence).toBeGreaterThanOrEqual(env.IMAGE_MATCH_THRESHOLD);
    expect(classifyImageMatchDecision(
      scores[0]?.confidence ?? 0,
      (scores[0]?.confidence ?? 0) - (scores[1]?.confidence ?? 0),
      scores[0]?.matchType,
    )).toBe('auto_match');
  });

  test('same image resized, lightly cropped, and brightness-adjusted still ranks the inventory product first', async () => {
    const inventory = await jpg(garmentSvg({}));
    const transformed = await sharp(inventory)
      .extract({ left: 8, top: 8, width: 344, height: 464 })
      .resize(420, 560, { fit: 'contain', background: '#ffffff' })
      .modulate({ brightness: 1.08 })
      .jpeg({ quality: 58 })
      .toBuffer();

    const scores = await rankImageMatches(transformed, [
      candidate('blue-suit', inventory, 'KD-104'),
      candidate('unrelated-item', await jpg(unrelatedSvg()), 'KD-999'),
    ]);

    expect(scores[0]?.productId).toBe('blue-suit');
    expect(scores[0]?.matchType).toBe('NEAR_DUPLICATE_MATCH');
    expect(scores[0]?.confidence).toBeGreaterThanOrEqual(env.IMAGE_MATCH_THRESHOLD);
  });

  test('should_rank_stitched_suits_mqw9xr87_first_for_its_own_whatsapp_image', async () => {
    const inventory = await jpg(garmentSvg({
      main: '#7f1d1d',
      accent: '#fecaca',
      embroidery: '#fbbf24',
    }));
    const whatsappLike = await sharp(inventory)
      .resize(512, 682, { fit: 'contain', background: '#ffffff' })
      .modulate({ brightness: 1.04 })
      .jpeg({ quality: 52 })
      .toBuffer();
    const similarWrongSuit = await jpg(garmentSvg({
      main: '#7f1d1d',
      accent: '#fecaca',
      embroidery: '#111827',
    }));

    const scores = await rankImageMatches(whatsappLike, [
      candidate('wrong-red-suit', similarWrongSuit, 'stitched-suits-similar-wrong'),
      candidate('reported-product', inventory, 'stitched-suits-mqw9xr87'),
      candidate('unrelated-item', await jpg(unrelatedSvg()), 'KD-999'),
    ]);

    expect(scores[0]?.sku).toBe('stitched-suits-mqw9xr87');
    expect(scores[0]?.matchType).toBe('NEAR_DUPLICATE_MATCH');
    expect(scores[0]?.confidence).toBeGreaterThan(scores[1]?.confidence ?? 0);
    expect(scores[1]?.sku).not.toBe('stitched-suits-mqw9xr87');
  });

  test('metadata removal, resize up/down, mild brightness, mild crop, and screenshot variants rank the same inventory image first', async () => {
    const inventory = await jpg(garmentSvg({ main: '#155e75', accent: '#a7f3d0', embroidery: '#7c2d12' }));
    const variants = [
      await sharp(inventory).withMetadata().jpeg({ quality: 84 }).toBuffer(),
      await sharp(inventory).resize(160, 220).jpeg({ quality: 80 }).toBuffer(),
      await sharp(inventory).resize(900, 1200).jpeg({ quality: 80 }).toBuffer(),
      await sharp(inventory).jpeg({ quality: 88 }).toBuffer(),
      await sharp(inventory).modulate({ brightness: 0.92 }).jpeg({ quality: 78 }).toBuffer(),
      await sharp(inventory).extract({ left: 10, top: 12, width: 340, height: 456 }).jpeg({ quality: 78 }).toBuffer(),
      await screenshotLike(inventory),
    ];
    const wrong = await jpg(garmentSvg({ main: '#155e75', accent: '#a7f3d0', embroidery: '#111827' }));

    for (const variant of variants) {
      const scores = await rankImageMatches(variant, [
        candidate('wrong-similar', wrong, 'same-colour-different-embroidery'),
        candidate('correct', inventory, 'stitched-suits-mqw9xr87'),
      ]);
      expect(scores[0]?.sku).toBe('stitched-suits-mqw9xr87');
    }
  });

  test('same colour with different embroidery stays a general visual match, not a near duplicate', async () => {
    const query = await jpg(garmentSvg({ main: '#be123c', accent: '#fecdd3', embroidery: '#facc15' }));
    const differentEmbroidery = await jpg(differentEmbroiderySvg({ main: '#be123c', accent: '#fecdd3', embroidery: '#facc15' }));
    const scores = await rankImageMatches(query, [
      candidate('different-embroidery', differentEmbroidery, 'DIFF-RED'),
    ]);

    expect(scores[0]?.matchType).toBe('GENERAL_MATCH');
    expect(scores[0]?.colorSimilarity).toBeGreaterThan(0.8);
  });

  test('corrupt, tiny, and blank images are rejected before matching', async () => {
    const corrupt = await inspectImageBuffer(Buffer.from('not really an image'));
    expect(corrupt.isUsable).toBe(false);
    expect(corrupt.reason).toBe('decode_failed');

    const tiny = await inspectImageBuffer(await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } }).png().toBuffer());
    expect(tiny.isUsable).toBe(false);
    expect(tiny.reason).toBe('too_small');

    const blank = await inspectImageBuffer(await sharp({ create: { width: 120, height: 120, channels: 3, background: '#fff' } }).png().toBuffer());
    expect(blank.isUsable).toBe(false);
    expect(blank.reason).toBe('blank_image');
  });

  test('duplicate and multiple inventory photos collapse to distinct product candidates', async () => {
    const inventory = await jpg(garmentSvg({}));
    const alternatePhoto = await sharp(inventory).resize(300, 420).jpeg({ quality: 90 }).toBuffer();
    const scores = await rankImageMatches(inventory, [
      candidate('blue-suit', inventory, 'KD-104-A'),
      candidate('blue-suit', alternatePhoto, 'KD-104-B'),
      candidate('green-suit', await jpg(garmentSvg({ main: '#276749', accent: '#c6f6d5' })), 'KD-105'),
    ]);

    expect(scores.map((score) => score.productId)).toEqual(['blue-suit', 'green-suit']);
    expect(scores[0]?.matchType).toBe('EXACT_MATCH');
    expect(scores[0]?.confidence).toBeGreaterThanOrEqual(env.IMAGE_MATCH_THRESHOLD);
  });

  test('near-duplicate evidence is accepted even when top and second generic scores would be close', async () => {
    const inventory = await jpg(garmentSvg({}));
    const compressed = await jpg(inventory, 48);
    const scores = await rankImageMatches(inventory, [
      candidate('blue-suit-a', compressed, 'KD-104-A'),
      candidate('blue-suit-b', await jpg(garmentSvg({ main: '#2b6cb0', accent: '#f6d365', embroidery: '#111827' })), 'KD-104-B'),
    ]);
    const margin = (scores[0]?.confidence ?? 0) - (scores[1]?.confidence ?? 0);

    expect(scores[0]?.confidence).toBeGreaterThanOrEqual(env.IMAGE_MATCH_THRESHOLD);
    expect(scores[0]?.matchType).toBe('NEAR_DUPLICATE_MATCH');
    expect(classifyImageMatchDecision(scores[0]?.confidence ?? 0, margin, scores[0]?.matchType)).toBe('auto_match');
  });

  test('close general visual scores with no near-duplicate evidence remain blocked by the margin rule', async () => {
    const query = await jpg(garmentSvg({ main: '#2b6cb0', accent: '#f6d365', embroidery: '#e53e3e' }));
    const scores = await rankImageMatches(query, [
      candidate('blue-suit-b', await jpg(differentEmbroiderySvg({ main: '#2b6cb0', accent: '#f6d365', embroidery: '#e53e3e' })), 'KD-104-B'),
      candidate('blue-suit-c', await jpg(differentEmbroiderySvg({ main: '#2b6cb0', accent: '#f6d365', embroidery: '#22543d' })), 'KD-104-C'),
    ]);
    const top = scores[0]?.confidence ?? 0;
    const margin = top - (scores[1]?.confidence ?? 0);

    expect(scores[0]?.matchType).toBe('GENERAL_MATCH');
    expect(margin).toBeLessThan(env.IMAGE_MIN_SCORE_MARGIN);
    expect(classifyImageMatchDecision(top, margin, scores[0]?.matchType)).toBe('no_match');
  });

  const privateFixturePaths = {
    blueScreenshot: '/Users/lovishgrover/Downloads/WhatsApp Image 2026-06-29 at 16.22.47.jpeg',
    floralScreenshot: '/Users/lovishgrover/Downloads/WhatsApp Image 2026-06-29 at 16.20.42.jpeg',
    blueInventory:
      '/Users/lovishgrover/Downloads/Cloudinary_Archive_2026-06-29_16_09_6_Originals/kbp3lyv0f2bkz7fgx4u9.jpg',
    floralInventory:
      '/Users/lovishgrover/Downloads/Cloudinary_Archive_2026-06-29_16_09_6_Originals/o4rg8jc2epk4eyaixwrx.jpg',
  };
  const hasPrivateFixtures = Object.values(privateFixturePaths).every((fixturePath) => existsSync(fixturePath));

  test.skipIf(!hasPrivateFixtures)('private Instagram/WhatsApp fixtures rank their matching inventory reference first', async () => {
    const candidates = [
      candidate(
        'blue-geometric-private-reference',
        readFileSync(privateFixturePaths.blueInventory),
        'blue-geometric-private-reference',
      ),
      candidate(
        'black-floral-private-reference',
        readFileSync(privateFixturePaths.floralInventory),
        'black-floral-private-reference',
      ),
    ];

    const blueScores = await rankImageMatches(readFileSync(privateFixturePaths.blueScreenshot), candidates);
    expect(blueScores[0]?.sku).toBe('blue-geometric-private-reference');
    expect(blueScores[0]?.matchType).toBe('GARMENT_EMBEDDING_MATCH');
    expect(blueScores[0]?.confidence).toBeGreaterThan(blueScores[1]?.confidence ?? 0);
    expect(blueScores[1]?.sku).toBe('black-floral-private-reference');
    expect(blueScores[1]?.matchType).toBe('GENERAL_MATCH');

    const floralScores = await rankImageMatches(readFileSync(privateFixturePaths.floralScreenshot), candidates);
    expect(floralScores[0]?.sku).toBe('black-floral-private-reference');
    expect(floralScores[0]?.matchType).toBe('LOCAL_FEATURE_MATCH');
    expect(floralScores[0]?.confidence).toBeGreaterThan(floralScores[1]?.confidence ?? 0);
    expect(floralScores[1]?.sku).toBe('blue-geometric-private-reference');
    expect(floralScores[1]?.matchType).toBe('GENERAL_MATCH');
  });
});
