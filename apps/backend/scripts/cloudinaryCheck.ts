/**
 * Cloudinary integration check (production-safe).
 *
 * Verifies the Cloudinary account/credentials work end to end: upload → read metadata →
 * build an optimized (f_auto/q_auto) URL. Credentials are read from the ENVIRONMENT — they
 * are never hardcoded, so nothing secret is committed to the repo or printed in full.
 *
 * Run (pass creds inline for a one-off, or rely on your shell/host env):
 *   CLOUDINARY_CLOUD_NAME=de3y1vrq2 \
 *   CLOUDINARY_API_KEY=454736483186781 \
 *   CLOUDINARY_API_SECRET=your-real-secret \
 *   npm run cloudinary:check --workspace=@kda/backend
 */
import { v2 as cloudinary } from 'cloudinary';

async function main(): Promise<void> {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  const missing = [
    ['CLOUDINARY_CLOUD_NAME', cloudName],
    ['CLOUDINARY_API_KEY', apiKey],
    ['CLOUDINARY_API_SECRET', apiSecret],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    console.error(`Cloudinary env vars missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Configure from env. secure:true makes generated URLs https.
  cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });
  // Print only non-secret config so a leaked log never exposes the secret.
  console.log('Configured Cloudinary →', { cloud_name: cloudName, api_key: apiKey });

  // 1) Upload a sample image from Cloudinary's public demo domain into our products folder.
  const sample = 'https://res.cloudinary.com/demo/image/upload/sample.jpg';
  const uploaded = await cloudinary.uploader.upload(sample, { folder: 'kanika-boutique/products' });
  console.log('Uploaded:', { secureUrl: uploaded.secure_url, publicId: uploaded.public_id });

  // 2) Fetch metadata for the uploaded asset.
  const details = await cloudinary.api.resource(uploaded.public_id);
  console.log('Details:', {
    width: details.width,
    height: details.height,
    format: details.format,
    bytes: details.bytes,
  });

  // 3) Build an optimized URL:
  //    f_auto  → Cloudinary picks the best format for the requesting browser (e.g. AVIF/WebP).
  //    q_auto  → Cloudinary picks the best quality/size trade-off automatically.
  const optimizedUrl = cloudinary.url(uploaded.public_id, {
    fetch_format: 'auto', // f_auto
    quality: 'auto', // q_auto
    secure: true,
  });

  console.log('\nDone! Click link below to see the optimized version of the image. Check the size and the format.');
  console.log(optimizedUrl);
}

main().catch((err) => {
  // Surface the real Cloudinary error (e.g. 401 Invalid API key) without leaking the secret.
  console.error('Cloudinary check failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
