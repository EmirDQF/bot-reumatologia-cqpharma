import config from '../config/env.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

let cachedClient = null;

function normalizeGeminiModelName(rawName) {
  const value = typeof rawName === 'string' ? rawName.trim() : '';
  // Do not force a fallback model here. Return the raw value (may be empty) and let callers decide behavior.
  if (!value) return '';
  return value;
}

export function getGeminiClient() {
  if (cachedClient) {
    return cachedClient;
  }

  try {
    const apiKey = config.gemini?.apiKey || process.env.GEMINI_API_KEY;
    const modelName = normalizeGeminiModelName(config.gemini?.model || process.env.GEMINI_MODEL);
    const maxOutputTokens = Number(config.gemini?.maxOutputTokens || process.env.GEMINI_MAX_OUTPUT_TOKENS || 110);

    if (!apiKey) {
      console.warn('GEMINI_API_KEY not set; returning null client. Gemini calls will fall back to local heuristics in test mode.');
      return null;
    }

    console.log('[geminiClient] initializing client with model:', modelName);
    const generativeAi = new GoogleGenerativeAI(apiKey);
    cachedClient = generativeAi.getGenerativeModel({
      model: modelName,
      generationConfig: {
        maxOutputTokens,
      },
    });

    return cachedClient;
  } catch (error) {
    console.error('[geminiClient] Failed to initialize Gemini client', {
      message: error && error.message ? error.message : String(error),
      code: error && error.code ? error.code : null,
      status: error && error.status ? error.status : null,
      stack: error && error.stack ? error.stack : null,
    });
    return null;
  }
}
