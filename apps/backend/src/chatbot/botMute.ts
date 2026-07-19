// Owner "Mute bot" per-conversation toggle. When an owner mutes a contact (e.g. a
// supplier), the bot does ZERO processing for it — no matching, no replies, no
// escalations — until the owner unmutes. Persisted as Conversation.botMuted; the
// gate itself is a trivial pure check so it is unit-testable and obviously correct.

import type { Conversation } from '@kda/db';

/** True when the owner has muted the bot for this conversation. */
export function isBotMuted(conversation: Pick<Conversation, 'botMuted'>): boolean {
  return conversation.botMuted === true;
}
