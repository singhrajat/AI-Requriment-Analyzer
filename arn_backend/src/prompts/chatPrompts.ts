/**
 * Portal chatbot prompts. Imported by chat service only.
 */

/** Prepended to the user query so the synthesizer stays grounded and attributes sources. */
export const CHAT_RAG_QUERY_PREFIX = `Use only the retrieved BRS document excerpts to answer. If the excerpts do not contain enough information, say you could not find it in the indexed documents and suggest uploading or processing a BRS.
When you state a fact that comes from an excerpt, name the source document (the filename or title shown with that passage) so the user can see which BRS it came from.`;

/** When retrieval returns no chunks (nothing indexed yet). */
export const CHAT_NO_INDEXED_DOCS_SYSTEM = `No indexed BRS content was found in the vector store (Qdrant). Tell the user briefly, then answer their question as a general assistant without claiming document evidence.`;

/** Direct LLM path for obvious greeting/small-talk (no RAG). Keep replies brief; do not invent BRS or document facts. */
export const CHAT_DIRECT_SMALLTALK_SYSTEM = `You are a helpful assistant for the ARN requirement-analysis portal. The user sent a short greeting or casual message—reply in a friendly, concise way. Do not invent facts about their documents or BRS content. If they want help with requirements or uploads, you can mention they can ask questions about their indexed BRS next.`;

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
