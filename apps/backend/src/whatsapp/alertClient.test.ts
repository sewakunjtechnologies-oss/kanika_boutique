import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));

import axios from 'axios';
import { env } from '../config/env';
import { sendOwnerAlertTemplate } from './alertClient';

const input = {
  recipientNumber: '919254100603',
  templateName: 'owner_photo_escalation',
  languageCode: 'en',
  bodyParams: ['••••••0603', 'NO_MATCH', 'https://dash.example.com/conversations/c1'],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(axios.post).mockResolvedValue({ data: {} } as never);
  env.ALERT_ENABLED = true;
  env.ALERT_WABA_PHONE_NUMBER_ID = '111222333';
  env.ALERT_WABA_ACCESS_TOKEN = 'tok';
  env.ALERT_GRAPH_API_VERSION = 'v23.0';
});
afterEach(() => {
  env.ALERT_ENABLED = false;
  env.ALERT_WABA_PHONE_NUMBER_ID = '';
  env.ALERT_WABA_ACCESS_TOKEN = '';
});

describe('sendOwnerAlertTemplate', () => {
  test('disabled → no HTTP call', async () => {
    env.ALERT_ENABLED = false;
    expect(await sendOwnerAlertTemplate(input)).toEqual({ ok: false, reason: 'disabled' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('missing creds → not_configured, no HTTP call', async () => {
    env.ALERT_WABA_ACCESS_TOKEN = '';
    expect(await sendOwnerAlertTemplate(input)).toEqual({ ok: false, reason: 'not_configured' });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('sends a TEMPLATE message to the alert WABA with body params', async () => {
    const r = await sendOwnerAlertTemplate(input);
    expect(r).toEqual({ ok: true });
    const [url, payload, cfg] = vi.mocked(axios.post).mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v23.0/111222333/messages');
    expect((payload as any).type).toBe('template');
    expect((payload as any).template.name).toBe('owner_photo_escalation');
    expect((payload as any).template.language.code).toBe('en');
    expect((payload as any).template.components[0].parameters.map((p: any) => p.text)).toEqual(input.bodyParams);
    // Auth header carries the SEPARATE alert WABA token (not META_ACCESS_TOKEN).
    expect((cfg as any).headers.Authorization).toBe('Bearer tok');
  });

  test('API error → send_failed, never throws, no error detail leaked', async () => {
    vi.mocked(axios.post).mockRejectedValue(new Error('429 with request echo'));
    const r = await sendOwnerAlertTemplate(input);
    expect(r).toEqual({ ok: false, reason: 'send_failed' });
  });
});
