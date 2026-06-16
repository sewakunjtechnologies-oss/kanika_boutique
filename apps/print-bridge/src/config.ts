import path from 'node:path';
import fs from 'node:fs';
import 'dotenv/config';
import { z } from 'zod';

const envBool = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return value;
}, z.boolean());

const labelProfile = z.preprocess((value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '4x4') return '4x4_portrait';
  if (raw === '4x3_landscape' || raw === '4x3' || !raw) return '4x3';
  return raw;
}, z.enum(['4x3', '4x4_portrait']));

const rootEnvPath = path.resolve(__dirname, '../../../.env');
if (fs.existsSync(rootEnvPath)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv').config({ path: rootEnvPath, override: false });
}

const schema = z.object({
  BACKEND_URL: z.string().url(),
  PRINT_AGENT_TOKEN: z.string().min(1),
  DEVICE_ID: z.string().min(1).default('kanika-shop-laptop-01'),
  PRINTER_NAME: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(3000),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
  LABEL_PROFILE: labelProfile.default('4x3'),
  LABEL_WIDTH_MM: z.coerce.number().positive().optional(),
  LABEL_HEIGHT_MM: z.coerce.number().positive().optional(),
  PRINT_ORIENTATION: z.enum(['portrait']).default('portrait'),
  PRINT_ROTATION: z.coerce.number().int().refine((value) => value === 0, 'PRINT_ROTATION must be 0').default(0),
  PRINT_SCALE_MODE: z.enum(['noscale']).default('noscale'),
  PRINT_DRY_RUN: envBool.default(true),
  OUTPUT_DIR: z.string().default('./print-output'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid bridge environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const bridgeEnv = parsed.data;

export function outputPath(...parts: string[]): string {
  return path.resolve(process.cwd(), bridgeEnv.OUTPUT_DIR, ...parts);
}
