/* eslint-disable no-console */
/**
 * AI module smoke tests.
 *
 * Requires GEMINI_API_KEY set in .env for intent/payment and optional AI image fallback.
 * Deterministic image matching works without Gemini.
 *
 * Usage:
 *   npm run testai -w @kda/backend -- intent "kya yeh available hai"
 *   npm run testai -w @kda/backend -- intent-image ./photo.jpg "kitna ka hai"
 *   npm run testai -w @kda/backend -- match ./photo.jpg
 *   npm run testai -w @kda/backend -- payment ./screenshot.png 2499
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyIntent } from '../src/ai/intentClassifier';
import { matchProduct } from '../src/ai/productMatcher';
import { extractPayment } from '../src/ai/paymentExtractor';
import type { SupportedImageMimeType } from '../src/ai/schemas';

const [, , kind, ...rest] = process.argv;

async function readImage(
  filePath: string,
): Promise<{ base64: string; mediaType: SupportedImageMimeType }> {
  const buf = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mediaType: SupportedImageMimeType =
    ext === '.png'
      ? 'image/png'
      : ext === '.webp'
        ? 'image/webp'
        : ext === '.gif'
          ? 'image/gif'
          : 'image/jpeg';
  return { base64: buf.toString('base64'), mediaType };
}

async function main(): Promise<void> {
  if (!kind) usage();

  switch (kind) {
    case 'intent': {
      const text = rest.join(' ');
      if (!text) usage();
      console.log(JSON.stringify(await classifyIntent({ text }), null, 2));
      return;
    }
    case 'intent-image': {
      const [filePath, ...textParts] = rest;
      if (!filePath) usage();
      const { base64, mediaType } = await readImage(filePath);
      const out = await classifyIntent({
        text: textParts.join(' ') || undefined,
        imageBase64: base64,
        imageMediaType: mediaType,
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'match': {
      const [filePath] = rest;
      if (!filePath) usage();
      const { base64, mediaType } = await readImage(filePath);
      const out = await matchProduct({ imageBase64: base64, imageMediaType: mediaType });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'payment': {
      const [filePath, amountArg, upiArg] = rest;
      if (!filePath) usage();
      const { base64, mediaType } = await readImage(filePath);
      const out = await extractPayment({
        imageBase64: base64,
        imageMediaType: mediaType,
        expectedAmount: amountArg ? Number(amountArg) : undefined,
        expectedReceiverUpi: upiArg,
      });
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    default:
      usage();
  }
}

function usage(): never {
  console.error(
    [
      'Usage:',
      '  testai intent <text>                      — classify text-only',
      '  testai intent-image <file> [text]         — classify image (+ optional caption)',
      '  testai match <imagefile>                  — match against active catalog',
      '  testai payment <imagefile> [amount] [upi] — extract payment screenshot',
    ].join('\n'),
  );
  process.exit(1);
}

main().catch((err: unknown) => {
  if (err && typeof err === 'object' && 'status' in err) {
    const e = err as { status?: number; message?: string; error?: unknown };
    console.error(`AI API error (status ${e.status ?? '?'}): ${e.message ?? ''}`);
    if (e.error) console.error(JSON.stringify(e.error, null, 2));
  } else if (err instanceof Error) {
    console.error(err.message);
  } else {
    console.error(err);
  }
  process.exit(1);
});
