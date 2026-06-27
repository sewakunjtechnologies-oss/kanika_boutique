import { access } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, test } from 'vitest';
import { TEMP_MEDIA_DIR, withTemporaryMediaFile } from './tempMedia';

describe('temporary media files', () => {
  test('temp dir resolves under os.tmpdir() and never /var/data', () => {
    expect(TEMP_MEDIA_DIR.startsWith(os.tmpdir())).toBe(true);
    expect(TEMP_MEDIA_DIR).not.toContain('/var/data');
  });

  test('writes a uniquely-named file and deletes it after success', async () => {
    let usedPath = '';
    const result = await withTemporaryMediaFile(Buffer.from('hello'), '.jpg', async (filePath) => {
      usedPath = filePath;
      await access(filePath); // exists while the callback runs
      expect(filePath.startsWith(TEMP_MEDIA_DIR)).toBe(true);
      expect(filePath.endsWith('.jpg')).toBe(true);
      return 'ok';
    });
    expect(result).toBe('ok');
    await expect(access(usedPath)).rejects.toThrow(); // deleted afterwards
  });

  test('deletes the file even when the callback throws', async () => {
    let usedPath = '';
    await expect(
      withTemporaryMediaFile(Buffer.from('data'), '.png', async (filePath) => {
        usedPath = filePath;
        await access(filePath);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(access(usedPath)).rejects.toThrow(); // cleaned up on failure
  });

  test('uses a fresh filename on every call', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      await withTemporaryMediaFile(Buffer.from('x'), '.jpg', async (filePath) => {
        seen.add(filePath);
      });
    }
    expect(seen.size).toBe(3);
  });
});
