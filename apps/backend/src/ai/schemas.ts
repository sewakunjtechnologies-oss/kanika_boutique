import { Type, type Schema } from '@google/genai';
import { z } from 'zod';

// =============================================================================
// Intent classifier
// =============================================================================

export const IntentResultSchema = z.object({
  intent: z.enum(['ORDER_INTENT', 'PERSONAL_CHAT', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type IntentResult = z.infer<typeof IntentResultSchema>;

export const INTENT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['intent', 'confidence', 'reasoning'],
  properties: {
    intent: { type: Type.STRING, enum: ['ORDER_INTENT', 'PERSONAL_CHAT', 'UNKNOWN'] },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
};

export const DetailedIntentValueSchema = z.enum([
  'REJECT_PRODUCT',
  'CONFIRM_PRODUCT',
  'SHOW_AVAILABLE_PRODUCTS',
  'SHOW_PRODUCTS_BY_SIZE',
  'ASK_MORE_OPTIONS',
  'CHANGE_PRODUCT',
  'START_NEW_ORDER',
  'CANCEL_ORDER',
  'CANCEL_OR_CHANGE_AMBIGUOUS',
  'SELECT_PRODUCT_FROM_LIST',
  'ASK_PRICE',
  'ASK_STOCK',
  'ASK_SIZE_AVAILABILITY',
  'TALK_TO_HUMAN',
  'CASUAL_MESSAGE',
  'UNKNOWN',
]);
export type DetailedIntentValue = z.infer<typeof DetailedIntentValueSchema>;

export const DetailedIntentResultSchema = z.object({
  intent: DetailedIntentValueSchema,
  size: z.enum(['36', '38', '40', '42', '44', '46']).nullable(),
  selectedIndex: z.number().int().positive().nullable(),
  productQuery: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  language: z.enum(['english', 'hindi', 'hinglish', 'unknown']),
});
export type DetailedIntentResult = z.infer<typeof DetailedIntentResultSchema>;

export const DETAILED_INTENT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['intent', 'size', 'selectedIndex', 'productQuery', 'confidence', 'language'],
  properties: {
    intent: {
      type: Type.STRING,
      enum: [
        'REJECT_PRODUCT',
        'CONFIRM_PRODUCT',
        'SHOW_AVAILABLE_PRODUCTS',
        'SHOW_PRODUCTS_BY_SIZE',
        'ASK_MORE_OPTIONS',
        'CHANGE_PRODUCT',
        'START_NEW_ORDER',
        'CANCEL_ORDER',
        'CANCEL_OR_CHANGE_AMBIGUOUS',
        'SELECT_PRODUCT_FROM_LIST',
        'ASK_PRICE',
        'ASK_STOCK',
        'ASK_SIZE_AVAILABILITY',
        'TALK_TO_HUMAN',
        'CASUAL_MESSAGE',
        'UNKNOWN',
      ],
    },
    size: { type: Type.STRING, enum: ['36', '38', '40', '42', '44', '46'], nullable: true },
    selectedIndex: { type: Type.NUMBER, nullable: true },
    productQuery: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    language: { type: Type.STRING, enum: ['english', 'hindi', 'hinglish', 'unknown'] },
  },
};

// =============================================================================
// Product matcher
// =============================================================================

export const ProductMatchResultSchema = z.object({
  matchedProductId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type ProductMatchResult = z.infer<typeof ProductMatchResultSchema>;

export const PRODUCT_MATCH_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['matchedProductId', 'confidence', 'reasoning'],
  properties: {
    matchedProductId: { type: Type.STRING, nullable: true },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
};

// Product-match verifier: a constrained "same product?" yes/no check used to
// gate non-EXACT perceptual matches before they can auto-confirm.
export const ProductMatchVerifyResultSchema = z.object({
  sameProduct: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type ProductMatchVerifyResult = z.infer<typeof ProductMatchVerifyResultSchema>;

export const PRODUCT_MATCH_VERIFY_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: ['sameProduct', 'confidence', 'reasoning'],
  properties: {
    sameProduct: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
};

// =============================================================================
// Payment screenshot extractor
// =============================================================================

export const PaymentExtractionResultSchema = z.object({
  amount: z.number().nullable(),
  utr: z.string().nullable(),
  date: z.string().nullable(),
  receiverName: z.string().nullable(),
  receiverUpi: z.string().nullable(),
  looksLegitimate: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});
export type PaymentExtractionResult = z.infer<typeof PaymentExtractionResultSchema>;

export const PAYMENT_EXTRACTION_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  required: [
    'amount',
    'utr',
    'date',
    'receiverName',
    'receiverUpi',
    'looksLegitimate',
    'confidence',
    'reasoning',
  ],
  properties: {
    amount: { type: Type.NUMBER, nullable: true },
    utr: { type: Type.STRING, nullable: true },
    date: { type: Type.STRING, nullable: true },
    receiverName: { type: Type.STRING, nullable: true },
    receiverUpi: { type: Type.STRING, nullable: true },
    looksLegitimate: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    reasoning: { type: Type.STRING },
  },
};

// =============================================================================
// Shared
// =============================================================================

export type SupportedImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
