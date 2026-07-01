// Human-in-the-loop escalation for the image-match tail.
//
// Two triggers (wired in the orchestrator):
//   NO_MATCH          — the AI couldn't confidently identify the customer's photo.
//   CUSTOMER_REJECTED — the AI matched a product and the customer tapped NO.
//
// Each escalation is PERSISTED (a DashboardNotification row = the durable backlog,
// readAt == "handled") and EMITTED over socket.io ('escalation_created') so any open
// dashboard reacts instantly with a ping + toast. There is NO outbound WhatsApp alert
// — the owner is alerted inside the dashboard PWA (visible badge/queue when closed,
// live ping when open). Nothing here throws: a failure must never break the match flow.

import { prisma } from '@kda/db';
import { env } from '../config/env';
import { botError, botLog } from '../logger';
import { emitToDashboard } from '../realtime/io';

export type EscalationReason = 'NO_MATCH' | 'CUSTOMER_REJECTED' | 'MATCH_TIMEOUT';

export interface EscalationInput {
  conversationId: string;
  customerWhatsappNumber: string;
  reason: EscalationReason;
  /** Best-effort image reference for the dashboard (may be null when not stored). */
  imageUrl?: string | null;
}

/** Mask to the last 4 digits — never log/persist a full customer number. */
export function maskCustomerNumber(num: string): string {
  const digits = (num ?? '').replace(/[^\d]/g, '');
  if (digits.length <= 4) return digits ? `••••${digits}` : '••••';
  return `••••••${digits.slice(-4)}`;
}

export function conversationLink(conversationId: string): string {
  return `${env.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/conversations?id=${conversationId}`;
}

function reasonTitle(reason: EscalationReason): string {
  if (reason === 'NO_MATCH') return 'Unmatched customer photo';
  if (reason === 'CUSTOMER_REJECTED') return 'Customer rejected AI match';
  return 'Photo match timed out';
}

/**
 * Record + broadcast an escalation. Never throws.
 *   1. Persist a DashboardNotification (type PHOTO_ESCALATION) — the durable queue.
 *   2. Emit 'escalation_created' so open dashboards ping + toast immediately.
 */
export async function escalateToOwner(input: EscalationInput): Promise<void> {
  const masked = maskCustomerNumber(input.customerWhatsappNumber);
  const link = conversationLink(input.conversationId);
  const at = new Date().toISOString();

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
    botError('ERROR_DETAILS', err, { step: 'escalation_persist', reason: input.reason });
  }

  emitToDashboard('escalation_created', {
    conversationId: input.conversationId,
    customerMasked: masked,
    reason: input.reason,
    imageUrl: input.imageUrl ?? null,
    conversationLink: link,
    at,
  });

  botLog('PHOTO_ESCALATION', {
    conversationId: input.conversationId,
    reason: input.reason,
    customerMasked: masked,
    dashboardQueued: true,
  });
}
