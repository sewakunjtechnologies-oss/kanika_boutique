import { describe, expect, test } from 'vitest';
import { classifyLinkMessage, containsUrl, isLinkOnlyMessage } from './linkNudge';
import type { ChatEvent, OrderContext } from './stateMachine';

const text = (body: string): ChatEvent => ({ type: 'TEXT', body });
const image = (): ChatEvent => ({ type: 'IMAGE', mediaId: 'm1' });

describe('URL detection', () => {
  test('detects http(s), instagram.com, and short links', () => {
    expect(containsUrl('https://instagram.com/p/abc')).toBe(true);
    expect(containsUrl('check instagram.com/reel/x')).toBe(true);
    expect(containsUrl('https://bit.ly/3xyz')).toBe(true);
    expect(containsUrl('shared via youtu.be/xyz')).toBe(true);
    expect(containsUrl('amzn.to/3abc please')).toBe(true);
  });

  test('plain text without a URL is not a link', () => {
    expect(containsUrl('do you have this in size 40')).toBe(false);
    expect(isLinkOnlyMessage('do you have this in size 40')).toBe(false);
  });

  test('link with little other content is link-only; a long order message is not', () => {
    expect(isLinkOnlyMessage('https://instagram.com/p/abc')).toBe(true);
    expect(isLinkOnlyMessage('available? https://instagram.com/p/abc')).toBe(true);
    expect(isLinkOnlyMessage('check this suit https://instagram.com/p/abc')).toBe(true);
    // A genuine, wordy request that merely includes a link is left for normal flow.
    expect(
      isLinkOnlyMessage(
        'I want to order the blue cotton suit like the one here https://instagram.com/p/abc in size 40 quantity 2 please',
      ),
    ).toBe(false);
  });
});

describe('classifyLinkMessage', () => {
  const fresh: OrderContext = {};
  const nudged: OrderContext = { linkNudgeSent: true };

  test('first link-only message → nudge', () => {
    expect(classifyLinkMessage(text('https://instagram.com/p/abc'), fresh)).toBe('nudge');
  });

  test('second link after nudge → suppress (no duplicate)', () => {
    expect(classifyLinkMessage(text('https://instagram.com/p/def'), nudged)).toBe('suppress');
  });

  test('non-link text → none (normal processing)', () => {
    expect(classifyLinkMessage(text('hi do you have red kurti'), fresh)).toBe('none');
  });

  test('an image is never a link nudge → none (screenshot flows to matching)', () => {
    expect(classifyLinkMessage(image(), fresh)).toBe('none');
    expect(classifyLinkMessage(image(), nudged)).toBe('none');
  });
});
