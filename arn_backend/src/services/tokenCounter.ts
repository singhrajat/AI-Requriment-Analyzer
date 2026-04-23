import { encodingForModel, type TiktokenModel } from "js-tiktoken";

import { getOpenAiChatModelId } from "../config/modelConfig";

/**
 * Count the number of tokens in a text string using tiktoken.
 * Falls back to a word-based approximation if the model encoding is unavailable.
 */
export function countTokens(text: string): number {
  const model = getOpenAiChatModelId();
  try {
    const enc = encodingForModel(model as TiktokenModel);
    const tokens = enc.encode(text);
    return tokens.length;
  } catch {
    // Fallback: roughly 0.75 tokens per word
    return Math.ceil(text.split(/\s+/).length * 1.33);
  }
}

/**
 * Returns true if the input text fits within the given token threshold.
 * The threshold is read from the BRS_SMALL_INPUT_TOKEN_THRESHOLD env var,
 * defaulting to 4000 tokens.
 */
export function isSmallInput(text: string, threshold?: number): boolean {
  const limit = threshold ?? Number(process.env.BRS_SMALL_INPUT_TOKEN_THRESHOLD ?? "4000");
  return countTokens(text) <= limit;
}
