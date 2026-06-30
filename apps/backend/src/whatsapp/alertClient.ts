// Owner ESCALATION alert sender — DELIBERATELY standalone.
//
// This uses a SEPARATE Meta-verified WhatsApp number (its own WABA phone-number-id
// + access token) to message the owner, because the boutique bot's sender number IS
// the owner's number and a number cannot message itself. It is intentionally NOT
// wired through whatsapp/client.ts (customer messaging) so a failure in one channel
// can never affect the other.
//
// The alert is business-initiated (the owner has not messaged this number first), so
// free-form text would be rejected outside the 24h window — we send an APPROVED
// TEMPLATE. Never throws; returns a result the caller logs.

import axios from 'axios';
import { env } from '../config/env';

export interface OwnerAlertTemplateInput {
  recipientNumber: string;
  templateName: string;
  languageCode: string;
  /** Ordered body variables → {{1}}, {{2}}, {{3}} … */
  bodyParams: string[];
}

export type OwnerAlertResult =
  | { ok: true }
  | { ok: false; reason: 'disabled' | 'not_configured' | 'send_failed' };

/**
 * Send the owner-escalation WhatsApp template from the separate alert WABA.
 * Returns { ok:false, reason } instead of throwing on any disabled/misconfig/error
 * condition, so the caller can fall back to the dashboard queue and never crash the
 * match/confirm flow. Never logs the access token or the message bytes.
 */
export async function sendOwnerAlertTemplate(input: OwnerAlertTemplateInput): Promise<OwnerAlertResult> {
  if (!env.ALERT_ENABLED) return { ok: false, reason: 'disabled' };
  const recipient = input.recipientNumber.replace(/[^\d]/g, '');
  if (!env.ALERT_WABA_PHONE_NUMBER_ID || !env.ALERT_WABA_ACCESS_TOKEN || !recipient) {
    return { ok: false, reason: 'not_configured' };
  }

  const url = `https://graph.facebook.com/${env.ALERT_GRAPH_API_VERSION}/${env.ALERT_WABA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: 'whatsapp',
    to: recipient,
    type: 'template',
    template: {
      name: input.templateName,
      language: { code: input.languageCode },
      components: [
        {
          type: 'body',
          parameters: input.bodyParams.map((text) => ({ type: 'text', text })),
        },
      ],
    },
  };

  try {
    await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${env.ALERT_WABA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 12_000,
    });
    return { ok: true };
  } catch {
    // Intentionally swallow the error detail (it can echo request data); the caller
    // logs a structured ALERT_FAILED with a reason only.
    return { ok: false, reason: 'send_failed' };
  }
}
