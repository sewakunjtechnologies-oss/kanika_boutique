import { OrderStatus, prisma } from '@kda/db';

export type PaymentReviewWarning =
  | 'amount_missing'
  | 'amount_mismatch'
  | 'receiver_missing'
  | 'receiver_mismatch'
  | 'utr_missing'
  | 'duplicate_utr'
  | 'screenshot_suspicious';

export interface PaymentReviewInput {
  orderId: string;
  expectedAmount: number;
  expectedReceiverUpi: string;
  extractedAmount: number | null;
  extractedReceiver: string | null;
  extractedUtr: string | null;
  looksLegitimate: boolean | null;
  duplicateUtr: boolean;
}

export function buildPaymentReviewWarnings(input: PaymentReviewInput): PaymentReviewWarning[] {
  const warnings: PaymentReviewWarning[] = [];

  if (input.extractedAmount === null) {
    warnings.push('amount_missing');
  } else if (Math.abs(input.extractedAmount - input.expectedAmount) >= 0.5) {
    warnings.push('amount_mismatch');
  }

  if (!input.extractedReceiver) {
    warnings.push('receiver_missing');
  } else if (normalizePaymentText(input.extractedReceiver) !== normalizePaymentText(input.expectedReceiverUpi)) {
    warnings.push('receiver_mismatch');
  }

  if (!input.extractedUtr) {
    warnings.push('utr_missing');
  } else if (input.duplicateUtr) {
    warnings.push('duplicate_utr');
  }

  if (input.looksLegitimate !== true) warnings.push('screenshot_suspicious');

  return warnings;
}

export async function getPaymentReviewWarnings(input: Omit<PaymentReviewInput, 'duplicateUtr'>): Promise<PaymentReviewWarning[]> {
  const duplicateUtr = input.extractedUtr
    ? await prisma.order.findFirst({
        where: {
          id: { not: input.orderId },
          paymentExtractedUtr: input.extractedUtr,
          status: {
            in: [
              OrderStatus.PAYMENT_RECEIVED,
              OrderStatus.PAYMENT_REVIEW,
              OrderStatus.VERIFIED,
              OrderStatus.PRINTED,
              OrderStatus.DISPATCHED,
            ],
          },
        },
        select: { id: true },
      })
    : null;

  return buildPaymentReviewWarnings({ ...input, duplicateUtr: Boolean(duplicateUtr) });
}

export function normalizePaymentText(value: string): string {
  return value.trim().toLowerCase();
}
