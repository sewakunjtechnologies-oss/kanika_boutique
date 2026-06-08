import crypto from 'node:crypto';

const HEADER = 'x-hub-signature-256';
const PREFIX = 'sha256=';

// Constant-time HMAC SHA-256 verification per Meta's webhook spec.
// https://developers.facebook.com/docs/graph-api/webhooks/getting-started#payload
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret) return false; // fail closed when secret missing
  if (!signatureHeader || !signatureHeader.startsWith(PREFIX)) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signatureHeader.slice(PREFIX.length);

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

// Helper used by test scripts to mint a valid signature against a JSON string body.
export function signPayload(rawBody: Buffer | string, appSecret: string): string {
  const buf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const hex = crypto.createHmac('sha256', appSecret).update(buf).digest('hex');
  return `${PREFIX}${hex}`;
}

export const SIGNATURE_HEADER = HEADER;
