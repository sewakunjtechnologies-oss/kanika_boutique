import { callJsonOutput } from './callJsonOutput';
import { logger } from '../logger';
import {
  PAYMENT_EXTRACTION_RESPONSE_SCHEMA,
  PaymentExtractionResultSchema,
  type PaymentExtractionResult,
  type SupportedImageMimeType,
} from './schemas';

const SYSTEM_PROMPT = `You extract structured payment information from Indian UPI payment screenshots.

Common apps you may see: PhonePe, Google Pay, Paytm, BHIM, bank apps (HDFC, ICICI, SBI, Axis, Kotak, etc.).

Return ONLY JSON with these fields:
- amount: numeric INR amount paid (no currency symbol, no commas). Null if not visible.
- utr: 12-digit UTR / UPI reference / transaction ID (sometimes labeled "Transaction ID" or "UPI Ref. No"). Null if not visible.
- date: payment date as it appears in the screenshot (preserve original format). Null if not visible.
- receiverName: name of the payee / merchant. Null if not visible.
- receiverUpi: UPI ID of the payee (e.g. xyz@upi, name@okaxis). Null if not visible.
- looksLegitimate: true ONLY if the screenshot looks like a genuine completed payment confirmation. Set false on:
    * "Processing" / "Pending" status
    * Visible signs of editing (mismatched fonts, awkward alignment, color anomalies)
    * Screenshot of a screenshot (compression artifacts, browser chrome)
    * Missing critical fields (no amount, no UTR, no receiver)
    * Anything else that triggers suspicion
- confidence: 0-1 your overall confidence in the extracted values.
- reasoning: brief (1 sentence) explanation of what you saw and any concerns.

Be conservative — when uncertain, set looksLegitimate to false and confidence lower.`;

export interface PaymentExtractionInput {
  imageBase64: string;
  imageMediaType?: SupportedImageMimeType;
  expectedAmount?: number;
  expectedReceiverUpi?: string;
}

export async function extractPayment(
  input: PaymentExtractionInput,
): Promise<PaymentExtractionResult> {
  const contextLines: string[] = [];
  if (input.expectedAmount !== undefined) {
    contextLines.push(`Expected amount: ₹${input.expectedAmount}.`);
  }
  if (input.expectedReceiverUpi) {
    contextLines.push(`Expected receiver UPI: ${input.expectedReceiverUpi}.`);
  }
  const contextNote = contextLines.length ? `\n\n${contextLines.join(' ')}` : '';

  const { result, usage } = await callJsonOutput({
    systemPrompt: SYSTEM_PROMPT,
    contents: [
      {
        role: 'user',
        parts: [
          {
            inlineData: { mimeType: input.imageMediaType ?? 'image/jpeg', data: input.imageBase64 },
          },
          { text: `Extract payment info from this screenshot. Return JSON.${contextNote}` },
        ],
      },
    ],
    responseSchema: PAYMENT_EXTRACTION_RESPONSE_SCHEMA,
    schema: PaymentExtractionResultSchema,
    maxOutputTokens: 768,
  });

  if (!result) {
    return {
      amount: null,
      utr: null,
      date: null,
      receiverName: null,
      receiverUpi: null,
      looksLegitimate: false,
      confidence: 0,
      reasoning: 'extractor returned no valid output',
    };
  }

  logger.debug(
    {
      amount: result.amount,
      utr: result.utr,
      legitimate: result.looksLegitimate,
      confidence: result.confidence,
      usage,
    },
    'payment extracted',
  );
  return result;
}
