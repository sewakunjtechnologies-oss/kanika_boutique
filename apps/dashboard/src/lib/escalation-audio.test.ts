import { describe, expect, test } from 'vitest';
import { createPingPlayer, type AudioElementLike } from './escalation-audio';

function fakeElement(play: () => Promise<void> | void = () => undefined): AudioElementLike & {
  playCalls: number;
  pauseCalls: number;
} {
  const el = {
    volume: 0,
    muted: false,
    currentTime: 99,
    playCalls: 0,
    pauseCalls: 0,
    play() {
      this.playCalls += 1;
      return play();
    },
    pause() {
      this.pauseCalls += 1;
    },
  };
  return el;
}

describe('createPingPlayer (audio element)', () => {
  test('ping() plays the bundled asset from the start', () => {
    const el = fakeElement();
    const player = createPingPlayer(() => el);
    player.ping();
    expect(el.playCalls).toBe(1);
    expect(el.currentTime).toBe(0);
  });

  test('unlock() primes the element (play + pause) on first gesture', () => {
    const el = fakeElement();
    const player = createPingPlayer(() => el);
    player.unlock();
    expect(el.playCalls).toBe(1);
    expect(el.pauseCalls).toBe(1);
  });

  test('muted → ping() is a silent no-op', () => {
    const el = fakeElement();
    const player = createPingPlayer(() => el);
    player.setMuted(true);
    player.ping();
    expect(el.playCalls).toBe(0);
    expect(player.isMuted()).toBe(true);
  });

  test('audio unavailable (no Audio) → no-op, never throws', () => {
    const player = createPingPlayer(() => null);
    expect(() => {
      player.unlock();
      player.ping();
    }).not.toThrow();
  });

  test('autoplay BLOCKED (play() rejects) → visual-only, never throws / no unhandled rejection', () => {
    const el = fakeElement(() => Promise.reject(new Error('NotAllowedError')));
    const player = createPingPlayer(() => el);
    expect(() => {
      player.unlock();
      player.ping();
    }).not.toThrow();
  });

  test('element factory throwing → degrades gracefully', () => {
    const player = createPingPlayer(() => {
      throw new Error('blocked');
    });
    expect(() => player.ping()).not.toThrow();
  });
});
