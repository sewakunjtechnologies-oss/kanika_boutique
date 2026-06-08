import fs from 'node:fs/promises';
import path from 'node:path';
import type { StorageService } from './StorageService';

export class LocalStorage implements StorageService {
  constructor(private readonly rootDir: string) {}

  async save(buffer: Buffer, relativePath: string, _contentType: string): Promise<string> {
    const safe = this.assertSafePath(relativePath);
    const absolute = path.join(this.rootDir, safe);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, buffer);
    return safe;
  }

  resolve(identifier: string): string {
    return path.join(this.rootDir, this.assertSafePath(identifier));
  }

  private assertSafePath(rel: string): string {
    const normalized = path.posix.normalize(rel);
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
      throw new Error(`unsafe path: ${rel}`);
    }
    return normalized;
  }
}
