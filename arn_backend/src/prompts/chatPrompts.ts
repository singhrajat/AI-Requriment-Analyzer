/**
 * Portal chatbot prompts. Imported by chat service only.
 */

/** System instructions when answering without RAG (plain LLM). */
export const CHAT_DIRECT_SYSTEM_PROMPT = `You are a helpful assistant for the AI Requirement Analyzer (BRS) product.
Answer clearly and concisely. If you are unsure, say so.
Do not invent features of the product that you do not know.`;

/** Prepended to the user query when RAG is enabled so the synthesizer stays grounded. */
export const CHAT_RAG_QUERY_PREFIX = `Use only the retrieved BRS document excerpts to answer. If the excerpts do not contain enough information, say you could not find it in the indexed documents and suggest uploading or processing a BRS.`;

/** When DB search is on but nothing is indexed yet. */
export const CHAT_NO_INDEXED_DOCS_SYSTEM = `No BRS documents with embeddings were found in the database. Tell the user briefly, then answer their question as a general assistant without claiming document evidence.`;

/**
 * Build a single user message that includes optional conversation history for the query engine.
 */
export function buildAugmentedUserQuery(params: {
  message: string;
  history: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  useRagPrefix: boolean;
}): string {
  const parts: string[] = [];
  if (params.useRagPrefix) {
    parts.push(CHAT_RAG_QUERY_PREFIX);
    parts.push("");
  }
  const recent = params.history.slice(-12);
  if (recent.length > 0) {
    parts.push("Conversation so far:");
    for (const m of recent) {
      parts.push(`${m.role}: ${m.content}`);
    }
    parts.push("");
  }
  parts.push(`Current message: ${params.message}`);
  return parts.join("\n");
}
