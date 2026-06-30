// Human-in-the-loop escalation for the image-match tail.
//
// Two triggers (wired in the orchestrator):
//   NO_MATCH         — the AI couldn't confidently identify the customer's photo.
//   CUSTOMER_REJECTED — the AI matched a product and the customer tapped NO.
//
// Every escalation ALWAYS records to the dashboard queue (persisted
// DashboardNotification row + live socket event), independent of WhatsApp delivery.
// On top of that, the owner gets a debounced WhatsApp TEMPLATE alert via the separate
// alert WABA. Nothing here throws — an alert failure must never break the match flow.

import { prisma } from '@kda/db';
import { env } from '../config/env';
import { botError, botLog } from '../logger';
import { emitToDashboard } from '../realtime/io';
import { sendOwnerAlertTemplate } from '../whatsapp/alertClient';

export type EscalationReason = 'NO_MATCH' | 'CUSTOMER_REJECTED';

export interface EscalationInput {
  conversationId: string;
  customerWhatsappNumber: string;
  reason: EscalationReason;
  /** Best-effort image reference for the dashboard (may be null when not stored). */
  imageUrl?: string | null;
}

// In-memory debounce of the OWNER WhatsApp alert (not the dashboard queue), keyed by
// conversation. Single-process is sufficient for "a confused customer can't spam the
// owner"; the dashboard queue still records every escalation.
const lastOwnerAlertAt = new Map<string, number>();

/** Test seam: reset the debounce window. */
export function __resetEscalationStateForTests(): void {
  lastOwnerAlertAt.clear();
}

/** Mask to the last 4 digits — never log full customer numbers. */
export function maskCustomerNumber(num: string): string {
  const digits = (num ?? '').replace(/[^\d]/g, '');
  if (digits.length <= 4) return digits ? `••••${digits}` : '••••';
  return `••••••${digits.slice(-4)}`;
}

export function conversationLink(conversationId: string): string {
  return `${env.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/conversations/${conversationId}`;
}

function reasonTitle(reason: EscalationReason): string {
  return reason === 'NO_MATCH' ? 'Unmatched customer photo' : 'Customer rejected AI match';
}

/**
 * Record + dispatch an escalation. Never throws.
 *  1. Always: persist a DashboardNotification (backlog) + emit a live socket event.
 *  2. Best-effort + debounced + env-gated: owner WhatsApp template alert.
 */
export async function escalateToOwner(input: EscalationInput): Promise<void> {
  const now = Date.now();
  const masked = maskCustomerNumber(input.customerWhatsappNumber);
  const link = conversationLink(input.conversationId);

  // 1) Always-on dashboard queue (works even if WhatsApp send fails / is disabled).
  try {
    await prisma.dashboardNotification.create({
      data: {
        type: 'PHOTO_ESCALATION',
        title: reasonTitle(input.reason),
        body: `Customer ${masked} — ${input.reason}. Handle manually.`,
        entityType: 'conversation',
        entityId: input.conversationId,
        metadata: {
          reason: input.reason,
          customerMasked: masked,
          imageUrl: input.imageUrl ?? null,
          conversationLink: link,
        } as never,
      },
    });
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'escalation_dashboard_notification', reason: input.reason });
  }

  emitToDashboard('photo_escalation', {
    conversationId: input.conversationId,
    customerMasked: masked,
    reason: input.reason,
    imageUrl: input.imageUrl ?? null,
    conversationLink: link,
    at: new Date(now).toISOString(),
  });

  botLog('PHOTO_ESCALATION', {
    conversationId: input.conversationId,
    reason: input.reason,
    customerMasked: masked,
    dashboardQueued: true,
  });

  // 2) Owner WhatsApp template alert — debounced + env-gated + best-effort.
  if (!env.ALERT_ENABLED) return; // dashboard-only fallback
  const last = lastOwnerAlertAt.get(input.conversationId);
  if (last !== undefined && now - last < env.ALERT_DEBOUNCE_MINUTES * 60_000) {
    botLog('ALERT_DEBOUNCED', { conversationId: input.conversationId, reason: input.reason });
    return;
  }
  lastOwnerAlertAt.set(input.conversationId, now);

  try {
    const outcome = await sendOwnerAlertTemplate({
      recipientNumber: env.ALERT_RECIPIENT_NUMBER,
      templateName: env.ALERT_TEMPLATE_NAME,
      languageCode: env.ALERT_TEMPLATE_LANGUAGE,
      // {{1}}=masked customer, {{2}}=reason, {{3}}=dashboard conversation link.
      bodyParams: [masked, input.reason, link],
    });
    if (outcome.ok) {
      botLog('ALERT_SENT', { conversationId: input.conversationId, reason: input.reason });
    } else {
      botLog('ALERT_FAILED', { conversationId: input.conversationId, reason: input.reason, cause: outcome.reason });
    }
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'escalation_owner_alert', reason: input.reason });
    botLog('ALERT_FAILED', { conversationId: input.conversationId, reason: input.reason, cause: 'threw' });
  }
}
