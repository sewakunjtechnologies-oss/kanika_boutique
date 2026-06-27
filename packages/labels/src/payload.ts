import { z } from 'zod';
import type { LabelSizeName } from './profiles';

// Stable, typed label payload (Phase 4). This is what the backend stores on a
// PrintJob and what the bridge renders. It deliberately contains NO secrets:
// no payment screenshots, UPI ids, tokens or full phone numbers.

const LabelItemSchema = z.object({
  name: z.string().default(''),
  sku: z.string().default(''),
  size: z.string().default(''),
  quantity: z.number().int().nonnegative().default(0),
  unitPrice: z.number().nonnegative().default(0),
  amount: z.number().nonnegative().default(0),
});

const RawLabelPayloadSchema = z.object({
  templateVersion: z.enum(['online-order-label-v1', 'test-label-v1']),
  storeName: z.string().min(1),
  orderId: z.string().min(1),
  customerName: z.string().default(''),
  /** ISO order date/time, rendered as date + HH:MM on the label. */
  createdAt: z.string().default(''),
  /** Phone is pre-masked by the backend, e.g. "98XXXXXX21". */
  maskedPhone: z.string().default(''),
  phoneMasked: z.string().default(''),
  productName: z.string().default(''),
  sku: z.string().default(''),
  size: z.string().default(''),
  quantity: z.number().int().nonnegative().default(1),
  items: z.array(LabelItemSchema).default([]),
  subtotal: z.number().nonnegative().default(0),
  deliveryCharge: z.number().nonnegative().default(0),
  discount: z.number().nonnegative().default(0),
  grandTotal: z.number().nonnegative().default(0),
  amount: z.number().nonnegative().default(0),
  paymentStatus: z.string().default('PAID'),
  paymentType: z.string().default('UPI'),
  /** Value encoded in the Code-128 barcode (defaults to orderId). */
  barcodeValue: z.string().min(1),
  addressLine: z.string().default(''),
  addressLine1: z.string().default(''),
  addressLine2: z.string().default(''),
  city: z.string().default(''),
  state: z.string().default(''),
  pincode: z.string().default(''),
});

export const LabelPayloadSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const record = { ...(value as Record<string, unknown>) };
  if (!record.phoneMasked && record.maskedPhone) record.phoneMasked = record.maskedPhone;
  if (!record.maskedPhone && record.phoneMasked) record.maskedPhone = record.phoneMasked;
  if (!record.addressLine1 && record.addressLine) record.addressLine1 = record.addressLine;
  return record;
}, RawLabelPayloadSchema);

export type LabelPayload = z.infer<typeof LabelPayloadSchema>;

export function parseLabelPayload(value: unknown): LabelPayload {
  return LabelPayloadSchema.parse(value);
}

/**
 * Mask an Indian-style phone number for printing: keep the first 2 and last 2
 * digits, replace the middle with X. Never print the full number.
 */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return digits ? 'XXXX' : '';
  const last = digits.slice(-2);
  const tail = digits.slice(-4, -2); // helps disambiguate; still mostly masked
  void tail;
  const first = digits.slice(-10, -8) || digits.slice(0, 2);
  const middle = 'X'.repeat(Math.max(2, digits.length - 4));
  return `${first}${middle}${last}`;
}

/**
 * Build the idempotency key for the automatic ORDER_LABEL created when a
 * payment is approved. The key is fixed per order, so any retry of the payment
 * approval (or a duplicate webhook) can never create a second initial label.
 * Intentional reprints use a different, unique key.
 */
export function autoOrderLabelIdempotencyKey(orderId: string): string {
  return `ORDER:${orderId}:PAYMENT_APPROVED:INITIAL`;
}

/**
 * Build a unique idempotency key for an intentional manual reprint of an
 * order label. Each reprint is a distinct print job.
 */
export function reprintOrderLabelIdempotencyKey(orderId: string, uniqueId: string): string {
  return `ORDER:${orderId}:REPRINT:${uniqueId}`;
}

export interface LabelRenderRequest {
  payload: LabelPayload;
  labelSize: LabelSizeName;
}
