'use client';

// A small "ping" alert tone for escalations, synthesized with the Web Audio API —
// no bundled binary asset, no dependency. iOS/Safari blocks audio until the first
// user gesture, so callers must invoke unlock() on the first click/tap; if audio is
// still unavailable or blocked, every method degrades to a no-op (visual-only) and
// NEVER throws.

export interface PingPlayer {
  /** Call on the first user gesture (iOS audio unlock). Safe to call repeatedly. */
  unlock(): void;
  /** Play the alert ping (no-op when muted, unavailable, or blocked). */
  ping(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

type AudioContextLike = {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void> | void;
  createOscillator(): {
    frequency: { value: number };
    connect(node: unknown): void;
    start(): void;
    stop(when?: number): void;
  };
  createGain(): {
    gain: {
      value: number;
      setValueAtTime(v: number, t: number): void;
      exponentialRampToValueAtTime(v: number, t: number): void;
    };
    connect(node: unknown): void;
  };
};

/**
 * Build a ping player. `getAudioContext` is injectable for tests; in the browser it
 * defaults to window.AudioContext / webkitAudioContext (null when unsupported).
 */
export function createPingPlayer(getAudioContext?: () => AudioContextLike | null): PingPlayer {
  let ctx: AudioContextLike | null = null;
  let muted = false;

  function resolveContext(): AudioContextLike | null {
    if (ctx) return ctx;
    try {
      if (getAudioContext) {
        ctx = getAudioContext();
        return ctx;
      }
      const w = globalThis as unknown as {
        AudioContext?: new () => AudioContextLike;
        webkitAudioContext?: new () => AudioContextLike;
      };
      const Ctor = w.AudioContext ?? w.webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      return ctx;
    } catch {
      return null;
    }
  }

  function tone(frequency: number, peak: number, durationS: number): void {
    const c = resolveContext();
    if (!c) return;
    try {
      if (c.state === 'suspended') void c.resume();
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, c.currentTime);
      gain.gain.exponentialRampToValueAtTime(peak, c.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + durationS);
      osc.connect(gain);
      gain.connect(c.destination);
      osc.start();
      osc.stop(c.currentTime + durationS + 0.01);
    } catch {
      /* blocked / unavailable → visual-only, never throw */
    }
  }

  return {
    unlock() {
      // Prime the context on a user gesture: resume + a near-silent blip so iOS
      // permits later sounds. Failure is fine — we just fall back to visual-only.
      tone(440, 0.0001, 0.01);
    },
    ping() {
      if (muted) return;
      tone(880, 0.2, 0.35);
    },
    setMuted(m: boolean) {
      muted = m;
    },
    isMuted() {
      return muted;
    },
  };
}
