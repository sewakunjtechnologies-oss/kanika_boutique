import path from 'node:path';
import { prisma, MessageDirection, MessageType } from '@kda/db';
import { env } from '../config/env';
import { botError, botLog, logger } from '../logger';
import { storage } from '../storage';
import { graphApi, describeGraphError } from './graphClient';
import { ensureConversationForNumber, isTakeoverActive, type ConversationHandle } from './conversations';

// =============================================================================
// Public types
// =============================================================================

export interface InteractiveButton {
  /** Reply button id (we get this back on customer reply). Max 256 chars. */
  id: string;
  /** Button label shown to the customer. Trimmed to 20 chars by WhatsApp. */
  title: string;
}

export interface InteractiveListRow {
  id: string;
  title: string; // max 24
  description?: string; // max 72
}

export interface InteractiveListSection {
  title?: string; // max 24
  rows: InteractiveListRow[];
}

export type SendOutcome =
  | { ok: true; wamid: string; conversationId: string }
  | { ok: false; reason: 'human_takeover' | 'config_missing' | 'graph_error'; detail?: unknown };

export interface SendOptions {
  ignoreTakeover?: boolean;
}

// =============================================================================
// Send helpers
// =============================================================================

export async function sendText(to: string, body: string, options: SendOptions = {}): Promise<SendOutcome> {
  return withGuard(to, async (conv) => {
    const wamid = await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body, preview_url: false },
    });
    await recordOutbound(conv.conversationId, wamid, MessageType.TEXT, body, null);
    return wamid;
  }, options);
}

export async function sendImage(
  to: string,
  image: { link: string } | { id: string },
  caption?: string,
): Promise<SendOutcome> {
  return withGuard(to, async (conv) => {
    const wamid = await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { ...image, ...(caption ? { caption } : {}) },
    });
    const mediaRef = 'link' in image ? image.link : image.id;
    await recordOutbound(conv.conversationId, wamid, MessageType.IMAGE, caption ?? null, mediaRef);
    return wamid;
  });
}

export async function sendInteractiveButtons(
  to: string,
  bodyText: string,
  buttons: InteractiveButton[],
  options: { headerImageUrl?: string } = {},
): Promise<SendOutcome> {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error('WhatsApp interactive buttons require 1–3 buttons');
  }
  return withGuard(to, async (conv) => {
    const wamid = await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(options.headerImageUrl
          ? { header: { type: 'image', image: { link: options.headerImageUrl } } }
          : {}),
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    });
    await recordOutbound(
      conv.conversationId,
      wamid,
      MessageType.INTERACTIVE_BUTTON,
      bodyText,
      null,
    );
    return wamid;
  });
}

export async function sendInteractiveList(
  to: string,
  bodyText: string,
  buttonText: string,
  sections: InteractiveListSection[],
): Promise<SendOutcome> {
  if (sections.length === 0) throw new Error('Interactive list needs at least one section');
  return withGuard(to, async (conv) => {
    const wamid = await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: {
          button: buttonText.slice(0, 20),
          sections: sections.map((s) => ({
            ...(s.title ? { title: s.title.slice(0, 24) } : {}),
            rows: s.rows.map((r) => ({
              id: r.id,
              title: r.title.slice(0, 24),
              ...(r.description ? { description: r.description.slice(0, 72) } : {}),
            })),
          })),
        },
      },
    });
    await recordOutbound(conv.conversationId, wamid, MessageType.INTERACTIVE_LIST, bodyText, null);
    return wamid;
  });
}

export async function sendTemplate(
  to: string,
  templateName: string,
  lang: string,
  components: unknown[] = [],
): Promise<SendOutcome> {
  return withGuard(to, async (conv) => {
    const wamid = await postMessage({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang },
        ...(components.length ? { components } : {}),
      },
    });
    await recordOutbound(
      conv.conversationId,
      wamid,
      MessageType.TEMPLATE,
      `template:${templateName}`,
      null,
    );
    return wamid;
  });
}

// =============================================================================
// Media download — 2-step: GET /{id} for URL, then GET URL (also bearer-authed)
// =============================================================================

/** Customer media is a temporary matching input — keep this conservative. */
const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
const SUPPORTED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Fetch WhatsApp media entirely in memory and return the validated Buffer.
 * Never touches the filesystem, so it is safe on hosts (e.g. Render) where the
 * uploads disk is not writable. Logs only safe metadata — never the access
 * token or the signed media URL.
 */
export async function downloadMediaToBuffer(
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (!env.META_ACCESS_TOKEN) {
    throw new Error('META_ACCESS_TOKEN required for media download');
  }
  botLog('IMAGE_MEDIA_DOWNLOAD_STARTED', { mediaId });
  let stage = 'fetch_media_url';
  try {
    const meta = await graphApi.get<{ url?: string; mime_type?: string; sha256?: string }>(`/${mediaId}`);
    const url = meta.data.url;
    const metaMime = meta.data.mime_type ?? 'application/octet-stream';
    if (!url) throw new Error('no_media_url');

    stage = 'download_bytes';
    const dl = await graphApi.get<ArrayBuffer>(url, { responseType: 'arraybuffer', baseURL: '' });

    stage = 'validate';
    if (dl.status < 200 || dl.status >= 300) throw new Error(`bad_status_${dl.status}`);
    const headerType = (String(dl.headers?.['content-type'] ?? '').split(';')[0] ?? '')
      .trim()
      .toLowerCase();
    const mimeType = headerType || metaMime.toLowerCase();
    const buffer = Buffer.from(dl.data);
    if (buffer.byteLength === 0) throw new Error('empty_media_body');
    if (buffer.byteLength > MAX_MEDIA_BYTES) throw new Error('media_too_large');
    if (!mimeType.startsWith('image/')) throw new Error('non_image_content_type');
    if (!SUPPORTED_IMAGE_MIME.has(mimeType)) throw new Error('unsupported_image_type');

    botLog('IMAGE_MEDIA_DOWNLOAD_SUCCEEDED', {
      mediaId,
      status: dl.status,
      mimeType,
      bytes: buffer.byteLength,
    });
    return { buffer, mimeType };
  } catch (err) {
    botLog('IMAGE_MEDIA_DOWNLOAD_FAILED', {
      mediaId,
      failureStage: stage,
      error: err instanceof Error ? err.message : 'unknown_error',
    });
    throw err;
  }
}

/**
 * Disk-backed variant used by workflows that must persist the media (e.g. the
 * payment screenshot shown in the dashboard). The image matcher does NOT use
 * this — it consumes the in-memory Buffer from {@link downloadMediaToBuffer}.
 */
export async function downloadMedia(mediaId: string): Promise<{ storedPath: string; mimeType: string }> {
  const { buffer, mimeType } = await downloadMediaToBuffer(mediaId);
  const ext = mimeToExt(mimeType);
  const relativePath = path.posix.join('whatsapp-media', `${mediaId}${ext}`);
  const storedPath = await storage.save(buffer, relativePath, mimeType);
  botLog('IMAGE_DOWNLOADED', { mediaId, mimeType, bytes: buffer.byteLength, storedPath });
  return { storedPath, mimeType };
}

// =============================================================================
// Internal
// =============================================================================

async function withGuard(
  to: string,
  doSend: (conv: ConversationHandle) => Promise<string>,
  options: SendOptions = {},
): Promise<SendOutcome> {
  if (!env.META_ACCESS_TOKEN || !env.META_PHONE_NUMBER_ID) {
    logger.error(
      { hasToken: Boolean(env.META_ACCESS_TOKEN), hasPhoneId: Boolean(env.META_PHONE_NUMBER_ID) },
      'cannot send: META_ACCESS_TOKEN and/or META_PHONE_NUMBER_ID not set',
    );
    return { ok: false, reason: 'config_missing' };
  }

  const conv = await ensureConversationForNumber(to);
  if (!options.ignoreTakeover && isTakeoverActive(conv)) {
    logger.info(
      {
        recipientLast4: maskPhone(to),
        conversationId: conv.conversationId,
        until: conv.humanTakeoverUntil?.toISOString(),
      },
      'skipping send, human takeover active',
    );
    return { ok: false, reason: 'human_takeover' };
  }

  try {
    const wamid = await doSend(conv);
    return { ok: true, wamid, conversationId: conv.conversationId };
  } catch (err) {
    const info = describeGraphError(err);
    botError('ERROR_DETAILS', err, {
      step: 'graph_api_send',
      recipientLast4: maskPhone(to),
      status: info.status,
      data: info.data,
    });
    return { ok: false, reason: 'graph_error', detail: info };
  }
}

async function postMessage(payload: object): Promise<string> {
  const url = `/${env.META_PHONE_NUMBER_ID}/messages`;
  const p = payload as { to?: string; type?: string };
  logger.info({ recipientLast4: maskPhone(p.to), type: p.type }, 'reply send started');
  const resp = await graphApi.post<{ messages?: { id: string }[] }>(url, payload);
  const wamid = resp.data.messages?.[0]?.id;
  if (!wamid) {
    throw new Error(`graph api returned no wamid: ${JSON.stringify(resp.data)}`);
  }
  botLog('WHATSAPP_REPLY_SENT', { recipientLast4: maskPhone(p.to), type: p.type, wamid });
  return wamid;
}

async function recordOutbound(
  conversationId: string,
  wamid: string,
  type: MessageType,
  content: string | null,
  mediaUrl: string | null,
): Promise<void> {
  await prisma.message.create({
    data: {
      conversationId,
      direction: MessageDirection.OUTBOUND_BOT,
      messageType: type,
      content,
      mediaUrl,
      whatsappMessageId: wamid,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastOutboundAt: new Date() },
  });
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/3gpp': '.3gp',
    'application/pdf': '.pdf',
  };
  return map[mime] ?? '';
}

function maskPhone(value: string | undefined): string | null {
  if (!value) return null;
  return value.slice(-4);
}
