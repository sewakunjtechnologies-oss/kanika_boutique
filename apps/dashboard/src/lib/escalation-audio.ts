'use client';

// Alert "ping" for escalations, backed by a bundled static asset (public/sounds/
// ping.wav) played through an <audio> element. iOS/Safari blocks audio until the
// first user gesture, so callers MUST invoke unlock() on the first click/tap: it
// play()+pause()es a near-silent buffer to prime the element. If audio is still
// unavailable/blocked, every method degrades to a no-op (visual-only) and NEVER
// throws.

export const PING_SOUND_URL = '/sounds/ping.wav';

export interface PingPlayer {
  /** Prime on the first user gesture (iOS audio unlock). Safe to call repeatedly. */
  unlock(): void;
  /** Play the alert ping (no-op when muted, unavailable, or blocked). */
  ping(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

export interface AudioElementLike {
  volume: number;
  muted: boolean;
  currentTime: number;
  play(): Promise<void> | void;
  pause(): void;
}

/**
 * Build a ping player. `createElement` is injectable for tests; in the browser it
 * defaults to `new Audio(PING_SOUND_URL)` (null when Audio is unsupported).
 */
export function createPingPlayer(createElement?: () => AudioElementLike | null): PingPlayer {
  let el: AudioElementLike | null = null;
  let muted = false;

  function resolveElement(): AudioElementLike | null {
    if (el) return el;
    try {
      if (createElement) {
        el = createElement();
        return el;
      }
      const Ctor = (globalThis as unknown as { Audio?: new (src?: string) => AudioElementLike }).Audio;
      if (!Ctor) return null;
      el = new Ctor(PING_SOUND_URL);
      return el;
    } catch {
      return null;
    }
  }

  // A play() may return a promise that rejects (autoplay blocked). Swallow it so we
  // never surface an unhandled rejection or throw — visual toast/badge still fire.
  function safePlay(element: AudioElementLike): void {
    try {
      const p = element.play();
      if (p && typeof (p as Promise<void>).then === 'function') {
        (p as Promise<void>).catch(() => undefined);
      }
    } catch {
      /* blocked → visual-only */
    }
  }

  return {
    unlock() {
      const element = resolveElement();
      if (!element) return;
      try {
        // Play muted, then immediately pause + rewind — this "unlocks" the element
        // for later programmatic play() on iOS.
        element.muted = true;
        element.currentTime = 0;
        safePlay(element);
        element.pause();
        element.currentTime = 0;
        element.muted = false;
      } catch {
        /* never throw */
      }
    },
    ping() {
      if (muted) return;
      const element = resolveElement();
      if (!element) return;
      try {
        element.muted = false;
        element.volume = 1;
        element.currentTime = 0;
        safePlay(element);
      } catch {
        /* blocked / unavailable → visual-only */
      }
    },
    setMuted(m: boolean) {
      muted = m;
    },
    isMuted() {
      return muted;
    },
  };
}
