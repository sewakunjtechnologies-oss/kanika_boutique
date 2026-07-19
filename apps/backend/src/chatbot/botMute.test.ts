import { describe, expect, test } from 'vitest';
import { isBotMuted } from './botMute';

describe('bot mute gate', () => {
  test('muted conversation is skipped (zero processing)', () => {
    expect(isBotMuted({ botMuted: true })).toBe(true);
  });

  test('unmuted conversation processes normally', () => {
    expect(isBotMuted({ botMuted: false })).toBe(false);
  });
});
