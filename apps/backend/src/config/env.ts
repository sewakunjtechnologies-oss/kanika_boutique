import 'dotenv/config';
import { z } from 'zod';
import path from 'node:path';
import fs from 'node:fs';

// Load .env from the monorepo root so backend, scripts, and workers share one source.
const rootEnvPath = path.resolve(__dirname, '../../../../.env');
if (fs.existsSync(rootEnvPath)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: rootEnvPath, override: false });
}

const envBool = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const cookieSameSite = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  return value.trim().toLowerCase();
}, z.enum(['lax', 'strict', 'none']));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Hosts like Render/Heroku inject the listen port via PORT; we map it onto
  // BACKEND_PORT below so a single env var works everywhere.
  BACKEND_PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Absolute directory for uploaded media. Defaults to <repo>/uploads when unset
  // (local dev); in production point this at a persistent disk mount, e.g.
  // /var/data/uploads on Render.
  UPLOADS_DIR: z.string().optional(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  PUBLIC_BACKEND_URL: z.string().url().default('http://localhost:3001'),

  // Meta WhatsApp Cloud API.
  // In dev these can be empty; signature check fails closed when secret is empty.
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_ACCESS_TOKEN: z.string().default(''),
  META_PHONE_NUMBER_ID: z.string().default(''),
  META_WABA_ID: z.string().default(''),
  META_WEBHOOK_VERIFY_TOKEN: z.string().default(''),
  META_GRAPH_API_VERSION: z.string().default('v23.0'),

  // Google Gemini.
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-2.5-pro'),

  // Chatbot behavior.
  CHATBOT_DEBUG: envBool.default(false),
  CHATBOT_ENABLE_AI_IMAGE_MATCHING: envBool.default(false),
  ORDER_RESERVATION_MINUTES: z.coerce.number().int().positive().default(120),
  SUPPORT_NUDGE_DELAY_MINUTES: z.coerce.number().int().positive().default(3),
  SUPPORT_PHONE_NUMBER: z.string().default(''),

  // Printing. Manual mode always generates PDFs. PrintNode can be enabled later.
  PRINT_PROVIDER: z.enum(['manual', 'printnode']).default('manual'),
  PRINTNODE_API_KEY: z.string().default(''),
  PRINTNODE_PRINTER_ID: z.string().default(''),
  INVOICE_PRINTER_ID: z.string().default(''),
  LABEL_PRINTER_ID: z.string().default(''),
  RECEIPT_PRINTER_ID: z.string().default(''),
  AUTO_PRINT_ON_PAYMENT_APPROVAL: envBool.default(false),

  // Auth.
  JWT_SECRET: z.string().default('dev_jwt_secret_change_in_prod'),
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: envBool.default(false),
  COOKIE_SAME_SITE: cookieSameSite.default('lax'),

  // Dashboard URL (for CORS).
  DASHBOARD_PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_DASHBOARD_URL: z.string().url().default('http://localhost:3000'),

  // In development the API process can run workers for convenience. In
  // production, run `npm run start:worker --workspace=@kda/backend` separately.
  START_EMBEDDED_WORKERS: envBool.optional(),

  // Business settings (also overridable from Settings table).
  BUSINESS_NAME: z.string().default('Kanika Designs'),
  UPI_ID: z.string().default('kanikadesigns@upi'),
  DEFAULT_SHIPPING_FEE: z.coerce.number().default(100),

  // Owner/admin WhatsApp numbers for payment-approval alerts (E.164 without '+',
  // e.g. 919876543210). OWNER_WHATSAPP_NUMBER is the primary; ADMIN_WHATSAPP_NUMBERS
  // is an optional comma-separated list of additional recipients.
  OWNER_WHATSAPP_NUMBER: z.string().default(''),
  ADMIN_WHATSAPP_NUMBERS: z.string().default(''),
});

// Treat empty strings as missing so zod's .default(...) kicks in.
const cleaned: Record<string, string | undefined> = {};
for (const [k, v] of Object.entries(process.env)) {
  cleaned[k] = v === '' ? undefined : v;
}

// Many PaaS hosts (Render, Heroku, Railway) inject the bind port as PORT.
// Honor it without forcing operators to also set BACKEND_PORT.
cleaned.BACKEND_PORT ??= cleaned.PORT;

// Support common WhatsApp env names used by tutorials without hardcoding secrets.
cleaned.META_ACCESS_TOKEN ??= cleaned.WHATSAPP_TOKEN;
cleaned.META_PHONE_NUMBER_ID ??= cleaned.WHATSAPP_PHONE_NUMBER_ID;
cleaned.META_WEBHOOK_VERIFY_TOKEN ??= cleaned.VERIFY_TOKEN;
cleaned.META_GRAPH_API_VERSION ??= cleaned.GRAPH_API_VERSION;

const parsed = envSchema.safeParse(cleaned);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const productionErrors: Record<string, string[]> = {};
function addProductionError(key: string, message: string): void {
  productionErrors[key] = [...(productionErrors[key] ?? []), message];
}

if (parsed.data.NODE_ENV === 'production') {
  for (const key of [
    'DATABASE_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'META_APP_SECRET',
    'META_ACCESS_TOKEN',
    'META_PHONE_NUMBER_ID',
    'META_WEBHOOK_VERIFY_TOKEN',
    'PUBLIC_BACKEND_URL',
    'PUBLIC_DASHBOARD_URL',
  ] as const) {
    if (!cleaned[key]) addProductionError(key, 'is required in production');
  }
  if (!cleaned.JWT_SECRET || cleaned.JWT_SECRET.length < 32) {
    addProductionError('JWT_SECRET', 'must be set to at least 32 characters in production');
  }
  if (!parsed.data.COOKIE_SECURE) {
    addProductionError('COOKIE_SECURE', 'must be true in production');
  }
  if (!parsed.data.GEMINI_API_KEY) addProductionError('GEMINI_API_KEY', 'is required in production');
  if (isLocalhostUrl(parsed.data.PUBLIC_BACKEND_URL)) {
    addProductionError('PUBLIC_BACKEND_URL', 'must not point to localhost in production');
  }
  if (isLocalhostUrl(parsed.data.PUBLIC_DASHBOARD_URL)) {
    addProductionError('PUBLIC_DASHBOARD_URL', 'must not point to localhost in production');
  }
  if (parsed.data.COOKIE_DOMAIN && isLocalhostHost(parsed.data.COOKIE_DOMAIN)) {
    addProductionError('COOKIE_DOMAIN', 'must not be localhost in production');
  }
  if (parsed.data.COOKIE_SAME_SITE === 'none' && !parsed.data.COOKIE_SECURE) {
    addProductionError('COOKIE_SAME_SITE', 'none requires COOKIE_SECURE=true');
  }
  if (
    !areSameSiteUrls(parsed.data.PUBLIC_BACKEND_URL, parsed.data.PUBLIC_DASHBOARD_URL) &&
    parsed.data.COOKIE_SAME_SITE !== 'none'
  ) {
    addProductionError(
      'COOKIE_SAME_SITE',
      'must be none when backend and dashboard are on different site domains',
    );
  }
}

if (Object.keys(productionErrors).length > 0) {
  // eslint-disable-next-line no-console
  console.error('Invalid production environment variables:', productionErrors);
  process.exit(1);
}

export const env = parsed.data;

// Non-fatal warnings: in production these should be set, but we don't want dev startup to fail.
export function logMetaWarnings(warn: (msg: string) => void): void {
  if (env.NODE_ENV === 'production') {
    if (!env.META_APP_SECRET) warn('META_APP_SECRET is empty — signature verification will reject all webhooks');
    if (!env.META_WEBHOOK_VERIFY_TOKEN) warn('META_WEBHOOK_VERIFY_TOKEN is empty — verification handshake will fail');
    if (!env.META_ACCESS_TOKEN) warn('META_ACCESS_TOKEN is empty — outbound sends + media downloads will fail');
  }
}

function isLocalhostUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname;
    return isLocalhostHost(host);
  } catch {
    return false;
  }
}

function isLocalhostHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function areSameSiteUrls(a: string, b: string): boolean {
  try {
    return siteKey(new URL(a).hostname) === siteKey(new URL(b).hostname);
  } catch {
    return false;
  }
}

function siteKey(host: string): string {
  if (isLocalhostHost(host)) return host;
  const parts = host.split('.').filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}
