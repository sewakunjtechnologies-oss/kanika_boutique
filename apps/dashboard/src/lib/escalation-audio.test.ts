import { describe, expect, test, vi } from 'vitest';
import { createPingPlayer } from './escalation-audio';

function fakeContext() {
  const osc = { frequency: { value: 0 }, connect: vi.fn(), start: vi.fn(), stop: vi.fn() };
  const gain = {
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: vi.fn(),
  };
  return {
    ctx: {
      state: 'running',
      currentTime: 0,
      destination: {},
      resume: vi.fn(),
      createOscillator: vi.fn(() => osc),
      createGain: vi.fn(() => gain),
    },
    osc,
    gain,
  };
}

describe('createPingPlayer', () => {
  test('ping() plays a tone when audio is available', () => {
    const { ctx, osc } = fakeContext();
    const player = createPingPlayer(() => ctx as never);
    player.ping();
    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    expect(osc.start).toHaveBeenCalled();
    expect(osc.stop).toHaveBeenCalled();
  });

  test('unlock() resumes a suspended context (iOS) and never throws', () => {
    const { ctx } = fakeContext();
    ctx.state = 'suspended';
    const player = createPingPlayer(() => ctx as never);
    expect(() => player.unlock()).not.toThrow();
    expect(ctx.resume).toHaveBeenCalled();
  });

  test('muted → ping() is a silent no-op', () => {
    const { ctx } = fakeContext();
    const player = createPingPlayer(() => ctx as never);
    player.setMuted(true);
    player.ping();
    expect(ctx.createOscillator).not.toHaveBeenCalled();
    expect(player.isMuted()).toBe(true);
  });

  test('audio unavailable (no AudioContext) → degrades to no-op, never throws', () => {
    const player = createPingPlayer(() => null);
    expect(() => {
      player.unlock();
      player.ping();
    }).not.toThrow();
  });

  test('audio BLOCKED (factory/oscillator throws) → degrades to visual-only, never throws', () => {
    const player = createPingPlayer(() => {
      throw new Error('blocked by browser');
    });
    expect(() => {
      player.unlock();
      player.ping();
    }).not.toThrow();
  });
});
