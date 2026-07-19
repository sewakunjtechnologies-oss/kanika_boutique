// Link → screenshot redirect. Suppliers/customers often paste an Instagram/short
// link with little else ("available? <link>"). We do NOT fetch or scrape the URL
// (explicitly out of scope) — instead we reply ONCE per conversation asking for a
// screenshot/photo, which flows into the normal image-matching path. A follow-up
// image matches as usual; a second link never re-nudges.
//
// Detection is pure and unit-tested; the orchestrator wires the single side effect.

import { prisma } from '@kda/db';
import { botLog } from '../logger';
import { sendText } from '../whatsapp/client';
import type { ChatEvent, OrderContext } from './stateMachine';
import { readOrderContext } from './orderContextGuard';

export const LINK_NUDGE_MESSAGE =
  "Please send a screenshot or photo of the suit you'd like, and I'll check availability right away.";

/** A link-only message may carry at most this many non-URL words. */
export const LINK_NUDGE_MAX_OTHER_WORDS = 5;

// http(s) links, www.*, and bare domains on common TLDs / shorteners (instagram.com,
// bit.ly, t.co, amzn.to, youtu.be, …). Built fresh per call to avoid lastIndex state.
function urlRegex(): RegExp {
  return /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|in|co|me|ly|gg|be|to|app|link|page|shop|store|xyz|info|biz)(?:\/[^\s]*)?)/gi;
}

export function containsUrl(text: string): boolean {
  return urlRegex().test(text ?? '');
}

/**
 * True when the message contains a URL and little other content — the manufacturer/
 * spam "here's a link" shape. Long messages that merely happen to include a link
 * (e.g. a real order description) are left alone for normal processing.
 */
export function isLinkOnlyMessage(text: string): boolean {
  const value = (text ?? '').trim();
  if (!value) return false;
  const urls = value.match(urlRegex());
  if (!urls || urls.length === 0) return false;
  let residual = value;
  for (const url of urls) residual = residual.replace(url, ' ');
  const otherWords = residual.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word));
  return otherWords.length <= LINK_NUDGE_MAX_OTHER_WORDS;
}

export type LinkNudgeDecision = 'nudge' | 'suppress' | 'none';

/**
 * - 'nudge'    — link-only message and we have not nudged yet → send once.
 * - 'suppress' — link-only message but already nudged → drop silently (no dupes).
 * - 'none'     — not a link-only message → normal processing.
 */
export function classifyLinkMessage(event: ChatEvent, context: OrderContext): LinkNudgeDecision {
  if (event.type !== 'TEXT') return 'none';
  if (!isLinkOnlyMessage(event.body)) return 'none';
  return context.linkNudgeSent ? 'suppress' : 'nudge';
}

/** Send the one-time redirect nudge and mark it so it never repeats. */
export async function sendLinkNudge(params: {
  conversationId: string;
  customerWhatsappNumber: string;
  contextJson: unknown;
}): Promise<void> {
  await sendText(params.customerWhatsappNumber, LINK_NUDGE_MESSAGE);
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      contextJson: { ...readOrderContext(params.contextJson), linkNudgeSent: true } as never,
    },
  });
  botLog('LINK_NUDGE_SENT', { conversationId: params.conversationId });
}
