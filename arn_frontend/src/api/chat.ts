const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export type ChatHistoryRole = "user" | "assistant" | "system";

export type ChatHistoryMessage = {
  role: ChatHistoryRole;
  content: string;
};

export type StreamChatParams = {
  message: string;
  history: ChatHistoryMessage[];
  /** Optional Mongo run id; when set, restricts retrieval to a single BRS run on the server. */
  runId?: string;
  /**
   * When true, RAG also searches merge-report vectors for `runId`.
   * Omit or false for BRS-only retrieval (still scoped by runId when set).
   */
  includeMergeReportInRag?: boolean;
};

export type ChatCitation = {
  runId: string;
  sourceName: string;
  kind: "brs_chunk" | "brs_full" | "merged_report";
  chunkIndex?: number;
  /** Merge-only: dotted section path. */
  sectionPath?: string;
  /** Merge-only: 1-based part index when a section was split into multiple parts. */
  partIndex?: number;
  /** Merge-only: total number of parts for the section. */
  partCount?: number;
  score?: number;
};

export type SsePayload =
  | { type: "token"; token: string }
  | { type: "sources"; sources: ChatCitation[] }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * POST /api/chat — streams SSE `data: {...}` lines; yields assistant text chunks.
 */
export async function* streamChat(params: StreamChatParams): AsyncGenerator<SsePayload, void, undefined> {
  const res = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      message: params.message,
      history: params.history,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.includeMergeReportInRag === true ? { includeMergeReportInRag: true } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Chat request failed (${res.status})`);
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 2);
      if (!rawEvent.startsWith("data:")) continue;
      const jsonLine = rawEvent.replace(/^data:\s*/, "");
      let data: SsePayload;
      try {
        data = JSON.parse(jsonLine) as SsePayload;
      } catch {
        continue;
      }
      if (data.type === "token" && data.token) {
        yield data;
      } else if (data.type === "sources") {
        yield data;
      } else if (data.type === "error") {
        throw new Error(data.message || "Chat error");
      } else if (data.type === "done") {
        yield data;
      }
    }
  }
}
