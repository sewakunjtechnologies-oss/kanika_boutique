import type { Content, GenerateContentResponseUsageMetadata, Schema } from '@google/genai';
import { z } from 'zod';
import { GEMINI_MODEL, getGemini } from './geminiClient';
import { logger } from '../logger';

export interface JsonOutputCall<T> {
  systemPrompt: string;
  contents: Content[];
  responseSchema: Schema;
  schema: z.ZodType<T>;
  maxOutputTokens?: number;
  /** Optional model override (e.g. a cheaper flash model for a yes/no gate). */
  model?: string;
}

export interface JsonOutputResult<T> {
  result: T | null;
  usage: GenerateContentResponseUsageMetadata | undefined;
}

/**
 * Calls Gemini with a JSON-schema-constrained response, parses + Zod-validates.
 * Returns { result: null } on any failure (logged).
 */
export async function callJsonOutput<T>(opts: JsonOutputCall<T>): Promise<JsonOutputResult<T>> {
  const ai = getGemini();

  const response = await ai.models.generateContent({
    model: opts.model ?? GEMINI_MODEL,
    contents: opts.contents,
    config: {
      systemInstruction: opts.systemPrompt,
      responseMimeType: 'application/json',
      responseSchema: opts.responseSchema,
      maxOutputTokens: opts.maxOutputTokens ?? 768,
      // Lower temp for structured extraction tasks.
      temperature: 0.2,
    },
  });

  const usage = response.usageMetadata;
  const text = response.text;
  if (!text) {
    logger.warn({ finish: response.candidates?.[0]?.finishReason }, 'gemini returned no text');
    return { result: null, usage };
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(text);
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, 'gemini output is not valid JSON');
    return { result: null, usage };
  }

  const validation = opts.schema.safeParse(parsedRaw);
  if (!validation.success) {
    logger.warn(
      { errors: validation.error.flatten(), raw: parsedRaw },
      'gemini output failed Zod validation',
    );
    return { result: null, usage };
  }

  return { result: validation.data, usage };
}
