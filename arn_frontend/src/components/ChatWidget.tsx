import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { streamChat, type ChatCitation, type ChatHistoryMessage } from "../api/chat";
import "./ChatWidget.css";

type AssistantUiMessage = { role: "assistant"; content: string; citations?: ChatCitation[] };
type UiMessage = ChatHistoryMessage | AssistantUiMessage | { role: "error"; content: string };

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
  const [useDbSearch, setUseDbSearch] = useState(false);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

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
        useDbSearch,
        history: historyForApi,
      })) {
        if (evt.type === "token") {
          acc += evt.token;
          setMessages((prev) => {
            const next = [...prev];
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
              next[next.length - 1] = { role: "assistant", content: acc };
            }
            return next;
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
  }, [input, sending, messages, useDbSearch]);

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

          <div className="chat-widget-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={useDbSearch}
                onChange={(ev) => setUseDbSearch(ev.target.checked)}
              />
              Search docs
            </label>
          </div>

          <div className="chat-widget-messages" ref={listRef}>
            {messages.length === 0 ? (
              <p className="chat-widget-hint" style={{ margin: 0 }}>
                Ask a question. Turn on &quot;Search BRS docs&quot; to ground answers in uploaded pipeline documents.
              </p>
            ) : null}
            {messages.map((m, i) => (
              <div
                key={i}
                className={`chat-widget-bubble ${m.role === "error" ? "error" : m.role}`}
              >
                {m.content}
                {"citations" in m && m.role === "assistant" && m.citations && m.citations.length > 0 ? (
                  <div className="chat-widget-citations">
                    <strong>Sources</strong>
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
