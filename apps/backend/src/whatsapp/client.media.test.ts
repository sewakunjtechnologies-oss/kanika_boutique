import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { env } from '../config/env';

// --- mocks -----------------------------------------------------------------
const { graphGet, storageSave } = vi.hoisted(() => ({
  graphGet: vi.fn(),
  storageSave: vi.fn(async () => 'whatsapp-media/x.jpg'),
}));
vi.mock('./graphClient', () => ({
  graphApi: { get: (...args: unknown[]) => graphGet(...args) },
  describeGraphError: (err: unknown) => ({ message: err instanceof Error ? err.message : 'err' }),
}));
vi.mock('../storage', () => ({ storage: { save: storageSave, resolve: (p: string) => p } }));

vi.mock('@kda/db', () => ({
  prisma: { conversation: {}, message: {} },
  MessageDirection: { OUTBOUND_BOT: 'OUTBOUND_BOT' },
  MessageType: { IMAGE: 'IMAGE' },
}));
vi.mock('./conversations', () => ({
  ensureConversationForNumber: vi.fn(),
  isTakeoverActive: vi.fn(() => false),
}));

import { downloadMediaToBuffer, downloadMedia } from './client';

const ORIGINAL_TOKEN = env.META_ACCESS_TOKEN;

function mockMediaResponse(opts: { contentType?: string; body?: Uint8Array; status?: number }): void {
  graphGet.mockReset();
  // 1st call: GET /{id} -> media metadata. 2nd call: GET <signed url> -> bytes.
  graphGet
    .mockResolvedValueOnce({ data: { url: 'https://signed.example/media', mime_type: 'image/jpeg' } })
    .mockResolvedValueOnce({
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'image/jpeg' },
      data: (opts.body ?? new Uint8Array([1, 2, 3, 4])).buffer,
    });
}

beforeEach(() => {
  env.META_ACCESS_TOKEN = 'test-token';
  storageSave.mockClear();
});
afterEach(() => {
  env.META_ACCESS_TOKEN = ORIGINAL_TOKEN;
  vi.clearAllMocks();
});

describe('downloadMediaToBuffer', () => {
  test('1 + 2: fetches media into a Buffer without writing to disk', async () => {
    mockMediaResponse({ contentType: 'image/jpeg', body: new Uint8Array([10, 20, 30]) });

    const result = await downloadMediaToBuffer('media_1');

    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.buffer.length).toBe(3);
    expect(result.mimeType).toBe('image/jpeg');
    // No /var/data write — the matcher path must never touch storage.
    expect(storageSave).not.toHaveBeenCalled();
  });

  test('6: rejects a non-image content type', async () => {
    mockMediaResponse({ contentType: 'text/html', body: new Uint8Array([1, 2, 3]) });
    await expect(downloadMediaToBuffer('media_2')).rejects.toThrow('non_image_content_type');
    expect(storageSave).not.toHaveBeenCalled();
  });

  test('7: rejects an empty media body', async () => {
    mockMediaResponse({ contentType: 'image/jpeg', body: new Uint8Array([]) });
    await expect(downloadMediaToBuffer('media_3')).rejects.toThrow('empty_media_body');
  });

  test('rejects a non-2xx download status', async () => {
    mockMediaResponse({ status: 403, body: new Uint8Array([1, 2, 3]) });
    await expect(downloadMediaToBuffer('media_4')).rejects.toThrow('bad_status_403');
  });

  test('throws when the access token is missing', async () => {
    env.META_ACCESS_TOKEN = '';
    await expect(downloadMediaToBuffer('media_5')).rejects.toThrow('META_ACCESS_TOKEN');
  });
});

describe('downloadMedia (disk-backed, for persisted media)', () => {
  test('16: persists to storage for workflows that require a file', async () => {
    mockMediaResponse({ contentType: 'image/jpeg', body: new Uint8Array([1, 2, 3]) });

    const result = await downloadMedia('media_6');

    expect(storageSave).toHaveBeenCalledTimes(1);
    const [, relativePath] = storageSave.mock.calls[0] as unknown as [Buffer, string, string];
    expect(relativePath).toContain('whatsapp-media/');
    expect(result.mimeType).toBe('image/jpeg');
  });
});
