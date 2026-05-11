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
