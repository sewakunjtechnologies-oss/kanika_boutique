// Owner/admin payment-approval alerts.
//
// When a customer sends a payment screenshot and the order moves into a
// pending-approval state (PAYMENT_RECEIVED / PAYMENT_REVIEW), the boutique owner
// gets an instant WhatsApp message with the order details and a direct dashboard
// link. The owner does not need to keep the dashboard open.
//
// Sending here is best-effort: a failure must never break the customer flow, so
// every send is wrapped and only logged. The state machine never auto-approves —
// this only notifies a human.

import { env } from '../config/env';
import { logger } from '../logger';
import { sendText } from './client';

export interface PaymentApprovalMessageInput {
  orderId: string;
  orderNumber: string;
  amount: number | string;
  customerName?: string | null;
  customerPhone: string;
  productName?: string | null;
  utr?: string | null;
}

export interface AdminNotificationResult {
  /** Recipients we attempted to send to (0 = no admin numbers configured). */
  attempted: number;
  /** Recipients the Graph API accepted. */
  sent: number;
}

/**
 * Parse the owner + admin numbers into a deduped, ordered recipient list.
 * Pure (env passed in) so it can be unit-tested. The owner number is always
 * first when present.
 */
export function parseAdminNumbers(
  ownerNumber: string | undefined,
  adminNumbers: string | undefined,
): string[] {
  const raw = [ownerNumber ?? '', ...(adminNumbers ?? '').split(',')];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const cleaned = entry.replace(/[^\d]/g, '');
    if (cleaned.length === 0 || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

export function getAdminWhatsappNumbers(): string[] {
  return parseAdminNumbers(env.OWNER_WHATSAPP_NUMBER, env.ADMIN_WHATSAPP_NUMBERS);
}

/**
 * True when this order has not yet had an admin alert sent. Used by the
 * orchestrator to guarantee we don't notify repeatedly for the same payment.
 */
export function shouldSendAdminNotification(
  alreadyNotifiedAt: Date | string | null | undefined,
): boolean {
  return !alreadyNotifiedAt;
}

export function buildPaymentApprovalMessage(input: PaymentApprovalMessageInput): string {
  const dashboardUrl = `${env.PUBLIC_DASHBOARD_URL.replace(/\/+$/, '')}/orders/${input.orderId}`;
  const customer = [input.customerName?.trim(), input.customerPhone].filter(Boolean).join(' / ');
  return [
    '🔔 Payment approval needed',
    '',
    `Order: #${input.orderNumber}`,
    `Customer: ${customer}`,
    `Product: ${input.productName?.trim() || 'Not specified'}`,
    `Amount: ₹${input.amount}`,
    `Extracted UTR: ${input.utr?.trim() || 'Not detected'}`,
    'Status: Pending approval',
    '',
    'Approve or reject:',
    dashboardUrl,
  ].join('\n');
}

/**
 * Notify every configured owner/admin number about a payment awaiting approval.
 * Never throws: each send is isolated so one failure does not block the others,
 * and a total failure still returns normally so the customer flow continues.
 */
export async function notifyAdminsPaymentPending(
  input: PaymentApprovalMessageInput,
): Promise<AdminNotificationResult> {
  const numbers = getAdminWhatsappNumbers();
  if (numbers.length === 0) {
    logger.warn(
      { orderId: input.orderId },
      'payment approval needed but no OWNER_WHATSAPP_NUMBER/ADMIN_WHATSAPP_NUMBERS configured',
    );
    return { attempted: 0, sent: 0 };
  }

  const body = buildPaymentApprovalMessage(input);
  let sent = 0;
  for (const to of numbers) {
    try {
      // ignoreTakeover: this is an owner alert, always deliver it.
      const outcome = await sendText(to, body, { ignoreTakeover: true });
      if (outcome.ok) {
        sent += 1;
      } else {
        logger.error(
          { to, orderId: input.orderId, reason: outcome.reason },
          'admin payment notification not delivered',
        );
      }
    } catch (err) {
      logger.error({ err, to, orderId: input.orderId }, 'admin payment notification send threw');
    }
  }

  logger.info(
    { orderId: input.orderId, attempted: numbers.length, sent },
    'admin payment notification dispatched',
  );
  return { attempted: numbers.length, sent };
}
