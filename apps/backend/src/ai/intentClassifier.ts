import type { Part } from '@google/genai';
import { callJsonOutput } from './callJsonOutput';
import { logger } from '../logger';
import {
  DETAILED_INTENT_RESPONSE_SCHEMA,
  DetailedIntentResultSchema,
  INTENT_RESPONSE_SCHEMA,
  IntentResultSchema,
  type DetailedIntentResult,
  type IntentResult,
  type SupportedImageMimeType,
} from './schemas';
import { env } from '../config/env';

const SYSTEM_PROMPT = `You classify WhatsApp messages sent to a boutique that sells suits and lehengas.
ORDER_INTENT: messages asking about products, prices, sizes, availability, sending a clothing photo, asking to buy, asking about stock.
PERSONAL_CHAT: greetings to the owner personally, casual chitchat, family messages, non-business conversation, voice notes about personal topics.
Return ONLY JSON: { "intent": "ORDER_INTENT"|"PERSONAL_CHAT"|"UNKNOWN", "confidence": 0.0-1.0, "reasoning": "brief" }
When in doubt, return PERSONAL_CHAT — false positives on bot replies are worse than missed orders.

Messages may be in English, Hindi, or Hinglish (Hindi written in Latin script — e.g. "kya yeh available hai", "kitna ka hai").`;

export interface IntentInput {
  text?: string;
  imageBase64?: string;
  imageMediaType?: SupportedImageMimeType;
}

export interface CustomerIntentInput {
  text: string;
  currentState: string;
  lastSelectedProduct?: string | null;
  lastRejectedProduct?: string | null;
  knownSize?: string | null;
  lastBotWasProductConfirmation?: boolean;
  availableProductListShown?: boolean;
}

export type CustomerTriggerIntent = 'availability' | 'order' | 'casual' | 'unknown';

export interface CustomerTriggerResult {
  shouldTriggerBot: boolean;
  intent: CustomerTriggerIntent;
}

const DETAILED_SYSTEM_PROMPT = `You classify customer messages for a WhatsApp boutique bot.
The boutique sells kurtis and suits. Use the conversation context to classify the customer's next intent.

Return strict JSON only with this exact shape:
{
"intent": "REJECT_PRODUCT | CONFIRM_PRODUCT | SHOW_AVAILABLE_PRODUCTS | SHOW_PRODUCTS_BY_SIZE | ASK_MORE_OPTIONS | CHANGE_PRODUCT | START_NEW_ORDER | CANCEL_ORDER | CANCEL_OR_CHANGE_AMBIGUOUS | SELECT_PRODUCT_FROM_LIST | ASK_PRICE | ASK_STOCK | ASK_SIZE_AVAILABILITY | TALK_TO_HUMAN | CASUAL_MESSAGE | UNKNOWN",
"size": "36 | 38 | 40 | 42 | 44 | 46 | null",
"selectedIndex": number | null,
"productQuery": string | null,
"confidence": number,
"language": "english | hindi | hinglish | unknown"
}

Important rules:
- If the last bot message was product confirmation and customer says "No", "not this", "ye nahi chahiye", classify REJECT_PRODUCT.
- "show available products", "show me products", "available products", "show all" classify SHOW_AVAILABLE_PRODUCTS.
- "more options", "aur options dikhao", "dusre products dikhao" classify ASK_MORE_OPTIONS.
- "38 size mein kya hai", "40 size dikhao", "show available in 42" classify SHOW_PRODUCTS_BY_SIZE and extract size.
- If an available product list was shown and customer replies "1", "2", "3", classify SELECT_PRODUCT_FROM_LIST.
- "cancel" alone during an order can be ambiguous. Use CANCEL_OR_CHANGE_AMBIGUOUS unless customer clearly says cancel order/stop order/cancel completely.
- Never decide payment, dispatch, stock deduction, or order creation. Only classify text.`;

export async function classifyIntent(input: IntentInput): Promise<IntentResult> {
  if (!input.text && !input.imageBase64) {
    return { intent: 'UNKNOWN', confidence: 1, reasoning: 'no message content' };
  }

  const parts: Part[] = [];
  if (input.imageBase64) {
    parts.push({
      inlineData: { mimeType: input.imageMediaType ?? 'image/jpeg', data: input.imageBase64 },
    });
  }
  if (input.text) parts.push({ text: input.text });

  const { result, usage } = await callJsonOutput({
    systemPrompt: SYSTEM_PROMPT,
    contents: [{ role: 'user', parts }],
    responseSchema: INTENT_RESPONSE_SCHEMA,
    schema: IntentResultSchema,
    maxOutputTokens: 256,
  });

  if (!result) {
    return { intent: 'UNKNOWN', confidence: 0, reasoning: 'classifier returned no valid output' };
  }

  logger.debug(
    { intent: result.intent, confidence: result.confidence, usage },
    'intent classified',
  );
  return result;
}

export async function classifyCustomerIntent(input: CustomerIntentInput): Promise<DetailedIntentResult> {
  const fallback = classifyCustomerIntentDeterministic(input);
  if (!env.GEMINI_API_KEY || !input.text.trim()) return fallback;

  try {
    const safeContext = {
      currentState: input.currentState,
      hasLastSelectedProduct: Boolean(input.lastSelectedProduct),
      hasLastRejectedProduct: Boolean(input.lastRejectedProduct),
      knownSize: input.knownSize ?? null,
      lastBotWasProductConfirmation: Boolean(input.lastBotWasProductConfirmation),
      availableProductListShown: Boolean(input.availableProductListShown),
    };
    const { result, usage } = await callJsonOutput({
      systemPrompt: DETAILED_SYSTEM_PROMPT,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: JSON.stringify({
                message: input.text,
                context: safeContext,
              }),
            },
          ],
        },
      ],
      responseSchema: DETAILED_INTENT_RESPONSE_SCHEMA,
      schema: DetailedIntentResultSchema,
      maxOutputTokens: 256,
    });

    if (!result || result.confidence < 0.55) {
      logger.debug(
        { fallbackIntent: fallback.intent, geminiIntent: result?.intent ?? null, confidence: result?.confidence ?? 0, usage },
        'detailed intent fallback used',
      );
      return fallback;
    }

    logger.debug(
      {
        intent: result.intent,
        confidence: result.confidence,
        size: result.size,
        selectedIndex: result.selectedIndex,
        language: result.language,
        usage,
      },
      'detailed intent classified',
    );
    return result;
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : 'unknown',
        fallbackIntent: fallback.intent,
      },
      'detailed intent classifier failed; using deterministic fallback',
    );
    return fallback;
  }
}

export function classifyCustomerIntentDeterministic(input: CustomerIntentInput): DetailedIntentResult {
  const raw = input.text.trim();
  const text = normalize(raw);
  const size = extractBoutiqueSize(text);
  const listIndex = raw.match(/^\s*([1-9]\d?)\s*$/)?.[1];

  if (input.availableProductListShown && listIndex) {
    return result('SELECT_PRODUCT_FROM_LIST', 0.95, { selectedIndex: Number.parseInt(listIndex, 10) });
  }

  if (/^(agent|human|team|staff|didi|owner|talk to team|talk to boutique)$/.test(text)) {
    return result('TALK_TO_HUMAN', 0.95);
  }

  if (/\b(cancel order|cancel completely|stop order|cancel this order|cancel the order|order cancel)\b/.test(text)) {
    return result('CANCEL_ORDER', 0.95);
  }
  if (/^(cancel|cnl)$/.test(text)) return result('CANCEL_OR_CHANGE_AMBIGUOUS', 0.9);

  if (
    input.lastBotWasProductConfirmation &&
    /^(no|n|nahi|nahin|nope|wrong|not this|ye nahi|ye nahin|ye nahi chahiye|ye nahin chahiye|nahi chahiye|nahin chahiye)$/.test(text)
  ) {
    return result('REJECT_PRODUCT', 0.98);
  }
  if (/\b(not this|wrong product|no this is not|ye nahi chahiye|ye nahin chahiye|nahi chahiye|nahin chahiye)\b/.test(text)) {
    return result('REJECT_PRODUCT', 0.9);
  }
  if (/^(yes|y|haan|han|ha|ok|okay|correct|same|this|yeh|ye)$/.test(text)) {
    return result('CONFIRM_PRODUCT', 0.92);
  }

  if (/\b(change product|change the product|different product|another product|change item|new product|something else)\b/.test(text)) {
    return result('CHANGE_PRODUCT', 0.92);
  }

  if (
    /\b(show available products|show me products|available products|available suits dikhao|show all|products dikhao|suits dikhao)\b/.test(text)
  ) {
    return result('SHOW_AVAILABLE_PRODUCTS', 0.95);
  }
  if (/\b(more options|aur options dikhao|dusre products dikhao|other options|more products)\b/.test(text)) {
    return result('ASK_MORE_OPTIONS', 0.95);
  }

  const knownSize = normalizeSize(input.knownSize ?? null);
  if (knownSize && /\b(products in my size|my size|meri size|mere size|is size mein|iss size mein)\b/.test(text)) {
    return result('SHOW_PRODUCTS_BY_SIZE', 0.9, { size: knownSize });
  }

  if (size && /\b(size|mein|me|available|dikhao|kya hai|products|suits|show)\b/.test(text)) {
    return result('SHOW_PRODUCTS_BY_SIZE', 0.93, { size });
  }

  if (/\b(price|rate|cost|amount|kitna|kitne|mrp)\b/.test(text)) return result('ASK_PRICE', 0.85);
  if (/\b(stock|available|availability|mil jayega|hai kya|h kya)\b/.test(text)) {
    return result('ASK_STOCK', 0.8, { size });
  }

  if (/\b(order|buy|purchase|book|new order)\b/.test(text)) return result('START_NEW_ORDER', 0.8);

  if (/^(hi|hii|hello|hey|how are you|how r u|namaste|good morning|good evening)$/.test(text)) {
    return result('CASUAL_MESSAGE', 0.9);
  }

  return result('UNKNOWN', 0.6);
}

export function detectCustomerIntent(text: string): CustomerTriggerResult {
  const normalized = normalizeTriggerText(text);
  if (!normalized) return { shouldTriggerBot: false, intent: 'casual' };

  if (isCasualTriggerText(normalized)) {
    return { shouldTriggerBot: false, intent: 'casual' };
  }

  if (isAvailabilityTriggerText(normalized)) {
    return { shouldTriggerBot: true, intent: 'availability' };
  }

  if (isOrderTriggerText(normalized) || isBrowseTriggerText(normalized)) {
    return { shouldTriggerBot: true, intent: 'order' };
  }

  return { shouldTriggerBot: false, intent: 'unknown' };
}

function result(
  intent: DetailedIntentResult['intent'],
  confidence: number,
  extra: Partial<Pick<DetailedIntentResult, 'size' | 'selectedIndex' | 'productQuery'>> = {},
): DetailedIntentResult {
  return {
    intent,
    size: extra.size ?? null,
    selectedIndex: extra.selectedIndex ?? null,
    productQuery: extra.productQuery ?? null,
    confidence,
    language: 'unknown',
  };
}

function extractBoutiqueSize(text: string): DetailedIntentResult['size'] {
  const match = text.match(/\b(36|38|40|42|44|46)\b/);
  if (!match?.[1]) return null;
  return match[1] as DetailedIntentResult['size'];
}

function normalizeSize(value: string | null): DetailedIntentResult['size'] {
  if (!value) return null;
  return extractBoutiqueSize(value);
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeTriggerText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[!?.,;:]+/g, ' ')
    .replace(/(.)\1{2,}/g, '$1$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isCasualTriggerText(text: string): boolean {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  if (
    /^(hi+|hello+|hey+|namaste|good morning|good afternoon|good evening|thanks|thank you|thx|ok|okay|k|fine|great|nice|cool)( ji| mam| maam| madam| didi| dear)?$/.test(
      text,
    )
  ) {
    return true;
  }
  if (/^(ji|haan ji|han ji|yes thanks|ok thanks|okay thanks)$/.test(text)) return true;
  if (/^(price|rate|cost|amount|kitna|kitne|mrp)$/.test(text)) return true;
  return false;
}

function isAvailabilityTriggerText(text: string): boolean {
  return (
    /\b(available|availability)\b/.test(text) ||
    /\b(stock|do you have|have this|mil jayega|hai kya|h kya)\b/.test(text) ||
    /\b(ye|yeh|yah|is this|this|suit|kurti|product).*\b(hai kya|available hai kya)\b/.test(text)
  );
}

function isOrderTriggerText(text: string): boolean {
  return (
    /\b(i want to order|want to order|mujhe .*order karna|order this|order karna|new order)\b/.test(text) ||
    /\b(can i buy|i want to buy|want to buy|buy this|purchase this|book this)\b/.test(text) ||
    /\b(i want this|mujhe ye|mujhe yeh|ye chahiye|yeh chahiye).*\b(suit|kurti|product|piece|item)?\b/.test(text) ||
    /\b(order|buy|purchase|book)\b.*\b(suit|kurti|product|item|piece|this|ye|yeh)\b/.test(text)
  );
}

function isBrowseTriggerText(text: string): boolean {
  return (
    /\b(show|browse|catalog|catalogue|collection|options|designs)\b.*\b(product|products|suit|suits|kurti|kurtis|item|items|options|designs)\b/.test(
      text,
    ) ||
    /\b(aur options|more options|dusre products|other products|products dikhao|suits dikhao|available suits dikhao)\b/.test(
      text,
    )
  );
}
