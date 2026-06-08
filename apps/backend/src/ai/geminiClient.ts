import { GoogleGenAI } from '@google/genai';
import { env } from '../config/env';

let _client: GoogleGenAI | null = null;

/** Lazily-constructed singleton. Throws if GEMINI_API_KEY is empty. */
export function getGemini(): GoogleGenAI {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  if (!_client) {
    _client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  }
  return _client;
}

export const GEMINI_MODEL: string = env.GEMINI_MODEL;
