import type { ChatEvent, OrderContext } from './stateMachine';

export const RESUME_CONFIRMATION_MESSAGE =
  'Your previous order was cancelled. Do you want to start a fresh order for this product? Reply YES to continue or TEAM to talk to the boutique team.';

export type PausedDecision = 'ignore' | 'attention' | 'ask_resume' | 'resume_yes' | 'team';

export function classifyPausedDecision(event: ChatEvent, context: OrderContext): PausedDecision {
  const text = eventText(event);
  if (text && isTeamReply(text)) return 'team';
  if (text && isYesReply(text) && context.pendingRestart) return 'resume_yes';
  if (event.type === 'IMAGE') return 'ask_resume';
  if (!text) return 'ignore';
  if (isAttentionPing(text)) return 'attention';
  if (isGreetingOnly(text)) return 'ignore';
  if (looksLikeRestartIntent(text)) return 'ask_resume';
  return 'ignore';
}

export function isYesReply(text: string): boolean {
  return /^(yes|y|haan|han|ha|ok|okay|continue|start|start order)$/i.test(text.trim());
}

export function isTeamReply(text: string): boolean {
  return /^(team|agent|human|staff|boutique|didi|owner|talk to team|talk to boutique)$/i.test(text.trim());
}

export function isGreetingOnly(text: string): boolean {
  const normalized = normalize(text);
  return /^(hi|hii|hello|hey|how are you|how r u|kaise ho|kaisi ho|namaste|good morning|good evening)$/.test(normalized);
}

export function isAttentionPing(text: string): boolean {
  return /^[?\s]+$/.test(text.trim()) || /^(reply|please reply|any update|koi hai)$/i.test(text.trim());
}

export function looksLikeRestartIntent(text: string): boolean {
  const normalized = normalize(text);
  return /\b(order|new order|fresh order|buy|purchase|book|available|availability|check this|is this available|product|article|suit|kurti|saree|lehenga|want to order|order something else)\b/.test(normalized);
}

export function rejectsPreviousProduct(context: OrderContext): boolean {
  return context.productRejected === true ||
    context.lastImageUsable === false ||
    context.awaitingNewProduct === true;
}

export function canUseConversationImageForRestart(context: OrderContext): boolean {
  return !rejectsPreviousProduct(context);
}

export function hasReusablePendingRestart(
  context: OrderContext,
  pending: OrderContext['pendingRestart'],
): boolean {
  if (!pending) return false;
  const explicitImageMediaId = pending.quotedImageMediaId ?? pending.imageMediaId ?? null;
  const fallbackImageMediaId = pending.latestImageMediaId ?? null;
  const mediaId = explicitImageMediaId ?? fallbackImageMediaId;
  const text = `${pending.caption ?? ''} ${pending.text ?? ''}`.trim();

  if (rejectsPreviousProduct(context)) {
    if (!explicitImageMediaId && fallbackImageMediaId) return false;
    if (mediaId && context.rejectedImageMediaId && mediaId === context.rejectedImageMediaId) return false;
    if (!mediaId && !looksLikeSpecificProductReference(text)) return false;
  }

  return Boolean(mediaId || looksLikeSpecificProductReference(text));
}

function eventText(event: ChatEvent): string {
  if (event.type === 'TEXT') return event.body;
  if (event.type === 'IMAGE') return event.caption ?? '';
  if (event.type === 'BUTTON_REPLY' || event.type === 'LIST_REPLY') return event.title;
  return '';
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9?]+/g, ' ').trim();
}

function looksLikeSpecificProductReference(text: string): boolean {
  const normalized = normalize(text);
  return /\b(article|art|sku|code)\s*[a-z0-9-]*\d+[a-z0-9-]*\b/.test(normalized) ||
    /\b[a-z]+\s+(suit|kurti|saree|lehenga)\b/.test(normalized);
}
