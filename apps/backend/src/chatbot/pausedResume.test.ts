import { describe, expect, test } from 'vitest';
import {
  classifyPausedDecision,
  hasReusablePendingRestart,
  RESUME_CONFIRMATION_MESSAGE,
  UNMATCHED_IMAGE_REPLY,
} from './pausedResume';

describe('paused resume handling', () => {
  test('paused + greeting does not restart', () => {
    expect(
      classifyPausedDecision({ type: 'TEXT', body: 'Hi' }, { botPausedReason: 'customer_cancelled' }),
    ).toBe('ignore');
    expect(
      classifyPausedDecision({ type: 'TEXT', body: 'How are you' }, { botPausedReason: 'customer_cancelled' }),
    ).toBe('ignore');
  });

  test('paused + new order intent asks resume confirmation', () => {
    expect(
      classifyPausedDecision(
        { type: 'TEXT', body: 'I want to order something else' },
        { botPausedReason: 'customer_cancelled' },
      ),
    ).toBe('ask_resume');
    expect(RESUME_CONFIRMATION_MESSAGE).toContain('Reply YES to continue');
  });

  test('paused + image order intent asks resume confirmation', () => {
    expect(
      classifyPausedDecision(
        { type: 'IMAGE', mediaId: 'media_1', caption: 'Order' },
        { botPausedReason: 'customer_cancelled' },
      ),
    ).toBe('ask_resume');
  });

  test('YES resumes only when pending restart context exists', () => {
    expect(
      classifyPausedDecision(
        { type: 'TEXT', body: 'YES' },
        {
          botPausedReason: 'customer_cancelled',
          pendingRestart: { imageMediaId: 'media_1', requestedAt: '2026-06-07T00:00:00.000Z' },
        },
      ),
    ).toBe('resume_yes');
    expect(
      classifyPausedDecision({ type: 'TEXT', body: 'YES' }, { botPausedReason: 'customer_cancelled' }),
    ).toBe('ignore');
  });

  test('TEAM keeps human takeover path', () => {
    expect(
      classifyPausedDecision({ type: 'TEXT', body: 'TEAM' }, { botPausedReason: 'customer_cancelled' }),
    ).toBe('team');
  });

  test('repeated question marks notify dashboard without restart', () => {
    expect(
      classifyPausedDecision({ type: 'TEXT', body: '??' }, { botPausedReason: 'customer_cancelled' }),
    ).toBe('attention');
  });

  test('unmatched image fallback is customer-facing', () => {
    expect(UNMATCHED_IMAGE_REPLY).toContain('clearer');
    expect(UNMATCHED_IMAGE_REPLY).toContain('article');
  });

  test('after product-change, old image pending restart is not reusable', () => {
    expect(
      hasReusablePendingRestart(
        {
          botPausedReason: 'customer_cancelled',
          productRejected: true,
          lastImageUsable: false,
          awaitingNewProduct: true,
          rejectedImageMediaId: 'old_media',
        },
        { latestImageMediaId: 'old_media', text: 'I want to order something else', requestedAt: '2026-06-08T00:00:00.000Z' },
      ),
    ).toBe(false);
  });

  test('new explicit image after product-change can be used for resume confirmation', () => {
    expect(
      hasReusablePendingRestart(
        {
          botPausedReason: 'customer_cancelled',
          productRejected: true,
          lastImageUsable: false,
          awaitingNewProduct: true,
          rejectedImageMediaId: 'old_media',
        },
        { imageMediaId: 'new_media', caption: 'Order', requestedAt: '2026-06-08T00:00:00.000Z' },
      ),
    ).toBe(true);
  });

  test('YES after invalid resume context is treated as invalid by reusable check', () => {
    const context = {
      botPausedReason: 'customer_cancelled' as const,
      productRejected: true,
      lastImageUsable: false,
      pendingRestart: {
        latestImageMediaId: 'old_media',
        requestedAt: '2026-06-08T00:00:00.000Z',
      },
    };
    expect(classifyPausedDecision({ type: 'TEXT', body: 'YES' }, context)).toBe('resume_yes');
    expect(hasReusablePendingRestart(context, context.pendingRestart)).toBe(false);
  });
});
