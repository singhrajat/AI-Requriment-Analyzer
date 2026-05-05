import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";
import { useLocation } from "react-router-dom";
import { streamChat, type ChatCitation, type ChatHistoryMessage } from "../api/chat";
import "./ChatWidget.css";

/** Mongo ObjectId hex format; matches the backend `mongoIdSchema`. */
const MONGO_ID_RE = /^[a-f0-9]{24}$/i;

/** Extract the run id from `/runs/:id` so chat retrieval can be scoped to that run. */
function useRouteRunId(): string | undefined {
  const { pathname } = useLocation();
  return useMemo(() => {
    const match = pathname.match(/^\/runs\/([^/?#]+)/);
    if (!match) return undefined;
    const id = match[1];
    return MONGO_ID_RE.test(id) ? id : undefined;
  }, [pathname]);
}

type AssistantUiMessage = { role: "assistant"; content: string; citations?: ChatCitation[] };
type UiMessage = ChatHistoryMessage | AssistantUiMessage | { role: "error"; content: string };

type BrsRunChip = { runId: string; label: string };

/** Unique BRS runs from citations (chunk/full only), stable label from first occurrence. */
function brsRunsFromCitations(citations: ChatCitation[]): BrsRunChip[] {
  const map = new Map<string, string>();
  for (const c of citations) {
    if (c.kind !== "brs_chunk" && c.kind !== "brs_full") continue;
    if (!map.has(c.runId)) map.set(c.runId, c.sourceName);
  }
  return [...map.entries()].map(([runId, label]) => ({ runId, label }));
}

function ChatBubbleIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path
        fill="currentColor"
        d="M4 4h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-4.6 3.45A1 1 0 0 1 4 20.1V18a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm1 4a1 1 0 1 0 0 2h10a1 1 0 1 0 0-2H5Zm0 4a1 1 0 1 0 0 2h14a1 1 0 1 0 0-2H5Z"
      />
    </svg>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>();
  const [selectedRunLabel, setSelectedRunLabel] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const routeRunId = useRouteRunId();
  const effectiveRunId = selectedRunId ?? routeRunId;

  useEffect(() => {
    if (!open) return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, open]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    const historyForApi: ChatHistoryMessage[] = messages
      .filter((m): m is ChatHistoryMessage => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    setInput("");
    setSending(true);
    setMessages((prev) => [...prev, { role: "user", content: text }, { role: "assistant", content: "" }]);

    try {
      let acc = "";
      for await (const evt of streamChat({
        message: text,
        history: historyForApi,
        ...(effectiveRunId ? { runId: effectiveRunId } : {}),
        ...(selectedRunId ? { includeMergeReportInRag: true } : {}),
      })) {
        if (evt.type === "token") {
          acc += evt.token;
          // Force a paint per chunk so SSE batches and React 18 automatic batching do not collapse the stream into one jump.
          flushSync(() => {
            setMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === "assistant") {
                next[next.length - 1] = { role: "assistant", content: acc };
              }
              return next;
            });
          });
        } else if (evt.type === "sources") {
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { role: "assistant", content: last.content, citations: evt.sources };
            }
            return next;
          });
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Something went wrong";
      setMessages((prev) => {
        const next = [...prev];
        const last = next[next.length - 1];
        if (last?.role === "assistant" && !last.content) {
          next.pop();
        }
        return [...next, { role: "error", content: msg }];
      });
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, effectiveRunId, selectedRunId]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      <button
        type="button"
        className="chat-widget-fab"
        aria-expanded={open}
        aria-label={open ? "Close chat" : "Open chat"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "×" : <ChatBubbleIcon />}
      </button>

      {open ? (
        <div className="chat-widget-panel" role="dialog" aria-label="Assistant chat">
          <div className="chat-widget-header">
            <h2>Assistant</h2>
            {sending ? (
              <div className="chat-widget-header-status" role="status" aria-live="polite">
                Thinking<span className="chat-widget-ellipsis" aria-hidden="true" />
              </div>
            ) : null}
            <div className="chat-widget-header-actions">
              <button
                type="button"
                className="chat-widget-clear"
                onClick={() => setMessages([])}
                disabled={sending || messages.length === 0}
              >
                Clear
              </button>
              <button type="button" className="chat-widget-close" aria-label="Close" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
          </div>

          {selectedRunLabel ? (
            <div className="chat-widget-scope" role="status">
              <span className="chat-widget-scope-label">
                Selected BRS: <strong>{selectedRunLabel}</strong>
                <span className="chat-widget-scope-meta"> — merge report included in search</span>
              </span>
              <button
                type="button"
                className="chat-widget-scope-clear"
                onClick={() => {
                  setSelectedRunId(undefined);
                  setSelectedRunLabel(undefined);
                }}
              >
                Clear selection
              </button>
            </div>
          ) : null}

          <div className="chat-widget-messages" ref={listRef}>
            {messages.length === 0 ? (
              <p className="chat-widget-hint" style={{ margin: 0 }}>
                Ask a question. Answers use indexed BRS text first; pick a BRS under Sources to include its merge
                report in later answers.
              </p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chat-widget-bubble ${m.role === "error" ? "error" : m.role}`}
              >
                {m.role === "assistant" && !m.content && sending && i === messages.length - 1 ? (
                  <span className="chat-widget-thinking" aria-label="Assistant is thinking">
                    <span className="chat-widget-thinking-dot" />
                    <span className="chat-widget-thinking-dot" />
                    <span className="chat-widget-thinking-dot" />
                  </span>
                ) : (
                  m.content
                )}
                {"citations" in m && m.role === "assistant" && m.citations && m.citations.length > 0 ? (
                  <div className="chat-widget-citations">
                    <strong>Sources</strong>
                    {(() => {
                      const brsChips = brsRunsFromCitations(m.citations);
                      return brsChips.length > 0 ? (
                        <div className="chat-widget-brs-chips" aria-label="BRS runs referenced">
                          {brsChips.map((chip) => (
                            <button
                              key={chip.runId}
                              type="button"
                              className={`chat-widget-brs-chip${chip.runId === selectedRunId ? " chat-widget-brs-chip-selected" : ""}`}
                              onClick={() => {
                                setSelectedRunId(chip.runId);
                                setSelectedRunLabel(chip.label);
                              }}
                            >
                              {chip.label}
                            </button>
                          ))}
                        </div>
                      ) : null;
                    })()}
                    <ul>
                      {m.citations.slice(0, 5).map((c, idx) => (
                        <li key={idx}>
                          {c.sourceName} ({c.kind}
                          {typeof c.chunkIndex === "number" ? ` #${c.chunkIndex}` : ""})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ))}
          </div>

          <form
            className="chat-widget-input-row"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Message…"
              disabled={sending}
              autoComplete="off"
              aria-label="Chat message"
            />
            <button type="submit" disabled={sending || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
