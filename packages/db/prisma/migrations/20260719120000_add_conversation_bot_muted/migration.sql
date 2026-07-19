-- Owner "Mute bot" per-conversation toggle: permanent human-takeover for a
-- contact (e.g. a supplier). While true the bot does zero processing.
ALTER TABLE "Conversation" ADD COLUMN "botMuted" BOOLEAN NOT NULL DEFAULT false;
