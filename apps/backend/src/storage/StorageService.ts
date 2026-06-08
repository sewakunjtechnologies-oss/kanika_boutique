// Abstracts file persistence so the same caller works against local disk in v1
// and S3 (or any other backend) later. Implementations return a path/URL that
// is safe to persist in the DB and later resolve for download.

export interface StorageService {
  /**
   * Persist `buffer` under `relativePath` (forward-slash separated).
   * Returns the storage-relative identifier to record in the DB
   * (e.g. "whatsapp-media/<id>.jpg" for LocalStorage, or an s3:// URL for S3).
   */
  save(buffer: Buffer, relativePath: string, contentType: string): Promise<string>;

  /** Resolve a stored identifier back to a readable absolute path or URL. */
  resolve(identifier: string): string;
}
