import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';

// productMatcher transitively imports @kda/db (prisma) at module load; the harness
// never touches the DB (candidates come from local files), so stub it out.
vi.mock('@kda/db', () => ({ prisma: {} }));

import { env } from '../config/env';
import { rankImageMatches, type ImageCandidate } from './imageMatcher';
import { selectMatchingProduct } from './productMatcher';
import { segmentGarmentOrOriginal } from './segmentation';

// =============================================================================
// Top-1 image-matching accuracy harness over a PRIVATE, LOCAL fixture corpus.
//
// This is the durable regression for the "white/cream garment resolves to a
// colour-distinct product" failure class. It is expressed generally via labelled
// fixtures — there is NO per-image / per-filename logic in the matcher.
//
// It makes REAL Gemini calls (verifier ON), so it only runs when you opt in:
//   RUN_IMAGE_ACCURACY=1  GEMINI_API_KEY=...  IMAGE_VERIFY_WITH_AI=true \
//   (optional) IMAGE_SEGMENTATION_ENABLED=true \
//   npx vitest run src/ai/imageAccuracy.test.ts
//
// Corpus layout (gitignored, kept off the repo — product images only, no PII):
//   apps/backend/.image-fixtures/manifest.json     (or set IMAGE_FIXTURE_DIR)
//   apps/backend/.image-fixtures/<imageFile>.jpg ...
// Manifest schema: see apps/backend/.image-fixtures.example.json
//
// When the corpus / key / opt-in is absent the suite SKIPS with a clear message
// (it never fails the normal `vitest run`).
// =============================================================================

interface CatalogFixture {
  id: string;
  sku: string;
  name: string;
  imageFile: string;
  baseColour?: string;
}
interface CaseFixture {
  photoFile: string;
  expectedProductId: string;
  note?: string;
  /** Product ids the photo must NEVER resolve to (e.g. colour-distinct lookalikes). */
  mustNotMatchProductIds?: string[];
}
interface Manifest {
  catalog: CatalogFixture[];
  cases: CaseFixture[];
}

const FIXTURE_DIR = process.env.IMAGE_FIXTURE_DIR || path.resolve(__dirname, '../../.image-fixtures');
const MANIFEST_PATH = path.join(FIXTURE_DIR, 'manifest.json');

const enabled =
  process.env.RUN_IMAGE_ACCURACY === '1' && Boolean(env.GEMINI_API_KEY) && existsSync(MANIFEST_PATH);

if (!enabled) {
  const why = process.env.RUN_IMAGE_ACCURACY !== '1'
    ? 'RUN_IMAGE_ACCURACY!=1'
    : !env.GEMINI_API_KEY
      ? 'GEMINI_API_KEY unset'
      : `manifest not found at ${MANIFEST_PATH}`;
  // eslint-disable-next-line no-console
  console.log(`[image-accuracy] SKIPPED (${why}). To run: RUN_IMAGE_ACCURACY=1 GEMINI_API_KEY=... IMAGE_VERIFY_WITH_AI=true npx vitest run src/ai/imageAccuracy.test.ts`);
}

const manifest: Manifest = enabled
  ? (JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Manifest)
  : { catalog: [], cases: [] };

const candidates: ImageCandidate[] = manifest.catalog.map((c) => ({
  productId: c.id,
  sku: c.sku,
  name: c.name,
  imageUrl: c.imageFile,
  imageBuffer: enabled ? readFileSync(path.join(FIXTURE_DIR, c.imageFile)) : Buffer.alloc(0),
}));

// Mirrors matchProduct's NON-near-duplicate verifier path: heuristic rank →
// top-K → garment segmentation → Gemini selector (verifier ON).
async function verifierPick(queryBuffer: Buffer): Promise<string | null> {
  const ranked = await rankImageMatches(queryBuffer, candidates);
  const topK = ranked
    .slice(0, env.IMAGE_VERIFY_TOP_K)
    .map((s) => candidates.find((c) => c.productId === s.productId))
    .filter((c): c is ImageCandidate => Boolean(c));

  const segQuery = await segmentGarmentOrOriginal(queryBuffer);
  const verifierCandidates = await Promise.all(
    topK.map(async (c) => ({
      productId: c.productId,
      sku: c.sku,
      imageBuffer: await segmentGarmentOrOriginal(c.imageBuffer),
      mimeType: 'image/jpeg' as const,
    })),
  );

  const selection = await selectMatchingProduct({
    queryBase64: segQuery.toString('base64'),
    queryMediaType: 'image/jpeg',
    candidates: verifierCandidates,
  });
  if (selection === 'unavailable') return null;
  return selection.productId !== null && selection.confidence >= env.IMAGE_VERIFY_MIN_CONFIDENCE
    ? selection.productId
    : null;
}

describe('image matching top-1 accuracy (private corpus, verifier ON)', () => {
  test.skipIf(!enabled)('every labelled photo resolves to its correct product (or no-match) — never a wrong/colour-distinct product', async () => {
    let correct = 0;
    const failures: string[] = [];

    for (const c of manifest.cases) {
      const queryBuffer = readFileSync(path.join(FIXTURE_DIR, c.photoFile));
      const chosen = await verifierPick(queryBuffer);

      // Hard safety: must never resolve to a forbidden (colour-distinct) lookalike,
      // and must be either the correct product or a clean no-match — never a 3rd product.
      const forbidden = c.mustNotMatchProductIds ?? [];
      const wrongProduct = chosen !== null && chosen !== c.expectedProductId;
      if (chosen !== null && forbidden.includes(chosen)) {
        failures.push(`${c.photoFile}: resolved to FORBIDDEN ${chosen} (expected ${c.expectedProductId})`);
      } else if (wrongProduct) {
        failures.push(`${c.photoFile}: resolved to WRONG ${chosen} (expected ${c.expectedProductId} or null)`);
      }
      if (chosen === c.expectedProductId) correct += 1;
    }

    // eslint-disable-next-line no-console
    console.log(`[image-accuracy] top-1 ${correct}/${manifest.cases.length}; safety failures: ${failures.length}`);
    // Never auto-pick a wrong product (the production safety contract).
    expect(failures, failures.join('\n')).toEqual([]);
    // And we expect the verifier to positively match the corpus.
    expect(correct).toBe(manifest.cases.length);
  }, 120_000);
});
