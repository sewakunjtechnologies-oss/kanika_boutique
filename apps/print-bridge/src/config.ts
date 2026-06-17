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
  PRINT_JOB_BATCH_SIZE: z.coerce.number().int().refine((value) => value === 1, 'PRINT_JOB_BATCH_SIZE must be 1').default(1),
  LABEL_SIZE: z.enum(['4x3', '4x4']).default('4x3'),
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
