import { describe, expect, test } from 'vitest';
import { isSupportReply, shouldSendSupportNudge } from './supportNudge';

describe('support nudge rules', () => {
  const now = new Date('2026-06-08T10:05:00.000Z');

  test('sends once after configured delay when customer has not replied', () => {
    expect(
      shouldSendSupportNudge({
        lastInboundAt: new Date('2026-06-08T10:00:00.000Z'),
        lastOutboundAt: new Date('2026-06-08T10:01:00.000Z'),
        supportNudgeSentAt: null,
        now,
        delayMinutes: 3,
      }),
    ).toBe(true);
  });

  test('does not send repeated nudges', () => {
    expect(
      shouldSendSupportNudge({
        lastInboundAt: new Date('2026-06-08T10:00:00.000Z'),
        lastOutboundAt: new Date('2026-06-08T10:01:00.000Z'),
        supportNudgeSentAt: new Date('2026-06-08T10:04:00.000Z'),
        now,
        delayMinutes: 3,
      }),
    ).toBe(false);
  });

  test('does not nudge if customer replied after bot prompt', () => {
    expect(
      shouldSendSupportNudge({
        lastInboundAt: new Date('2026-06-08T10:02:00.000Z'),
        lastOutboundAt: new Date('2026-06-08T10:01:00.000Z'),
        supportNudgeSentAt: null,
        now,
        delayMinutes: 3,
      }),
    ).toBe(false);
  });
});

describe('support replies', () => {
  test('CALL and HELP trigger support flow', () => {
    expect(isSupportReply('CALL')).toBe('CALL');
    expect(isSupportReply(' help ')).toBe('HELP');
  });

  test('other messages do not trigger support flow', () => {
    expect(isSupportReply('hello')).toBeNull();
  });
});
