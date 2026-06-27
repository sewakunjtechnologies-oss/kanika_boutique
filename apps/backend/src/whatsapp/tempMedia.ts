import { mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Directory for transient WhatsApp media artifacts. Resolves under the OS temp
 * dir (e.g. /tmp on Render) — never /var/data, which is not writable there.
 * The image matcher works on in-memory Buffers and does not need this; use it
 * only when a downstream API genuinely requires a file path.
 */
export const TEMP_MEDIA_DIR = path.join(os.tmpdir(), 'kanika-whatsapp-media');

/**
 * Write `buffer` to a uniquely-named temp file, run `fn` with its path, and
 * always delete the file afterwards (success or failure). Never reuses a fixed
 * filename, so concurrent requests cannot collide.
 */
export async function withTemporaryMediaFile<T>(
  buffer: Buffer,
  extension: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  await mkdir(TEMP_MEDIA_DIR, { recursive: true });
  const safeExt = extension && extension.startsWith('.') ? extension : extension ? `.${extension}` : '';
  const filePath = path.join(TEMP_MEDIA_DIR, `${randomUUID()}${safeExt}`);
  try {
    await writeFile(filePath, buffer);
    return await fn(filePath);
  } finally {
    await rm(filePath, { force: true }).catch(() => {});
  }
}
