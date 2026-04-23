const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:3000";

export type ChatHistoryRole = "user" | "assistant" | "system";

export type ChatHistoryMessage = {
  role: ChatHistoryRole;
  content: string;
};

export type StreamChatParams = {
  message: string;
  useDbSearch: boolean;
  history: ChatHistoryMessage[];
};

export type ChatCitation = {
  runId: string;
  sourceName: string;
  kind: "brs_chunk" | "brs_full" | "merged_report";
  chunkIndex?: number;
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
      useDbSearch: params.useDbSearch,
      history: params.history,
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
