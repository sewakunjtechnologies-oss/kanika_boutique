// OPTIONAL cheap non-garment rejector (TASK 4). When the heuristic top score is
// far below the match threshold, the photo is probably not even a garment (a
// screenshot of text, a meme, a random object). Rather than escalate every such
// photo to the owner, one cheap Gemini-flash yes/no "is this a garment?" gate lets
// us silently ignore obvious non-garments. Env-gated and default OFF, so with the
// flag off behaviour is identical to before (no extra AI call, no cost).

import { z } from 'zod';
import { Type, type Schema } from '@google/genai';
import { env } from '../config/env';
import { botError } from '../logger';
import { callJsonOutput } from '../ai/callJsonOutput';

/**
 * Only spend a Gemini call when the feature is on AND the heuristic score is far
 * below threshold (i.e. almost certainly not a real product match). Pure so the
 * policy is trivially unit-testable.
 */
export function shouldRunGarmentCheck(topScore: number, enabled: boolean, ceiling: number): boolean {
  return enabled && topScore <= ceiling;
}

const GarmentSchema = z.object({ isGarment: z.boolean() });
const GARMENT_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: { isGarment: { type: Type.BOOLEAN } },
  required: ['isGarment'],
};

/**
 * Ask a cheap flash model whether the image shows a garment. Returns:
 *   true  — it is a garment,
 *   false — confidently not a garment,
 *   null  — unknown (no API key / error) → callers must NOT suppress on null.
 */
export async function isGarmentImage(imageBase64: string, mimeType: string): Promise<boolean | null> {
  if (!env.GEMINI_API_KEY) return null;
  try {
    const { result } = await callJsonOutput({
      model: env.GARMENT_CHECK_MODEL,
      systemPrompt:
        'You are a strict binary image classifier for a women\'s clothing boutique. ' +
        'Decide whether the image primarily shows a wearable garment or fabric piece ' +
        '(suit, kurti, saree, dress, lehenga, dupatta, unstitched fabric, etc.). ' +
        'A screenshot of text/chat, a meme, a payment screenshot, a logo, a random ' +
        'object, food, or a blank image is NOT a garment. Respond only as JSON ' +
        '{"isGarment": true|false}.',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType, data: imageBase64 } },
            { text: 'Does this image show a garment?' },
          ],
        },
      ],
      responseSchema: GARMENT_RESPONSE_SCHEMA,
      schema: GarmentSchema,
      maxOutputTokens: 16,
    });
    return result ? result.isGarment : null;
  } catch (err) {
    botError('ERROR_DETAILS', err, { step: 'garment_check' });
    return null;
  }
}
