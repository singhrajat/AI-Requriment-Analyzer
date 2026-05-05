/**
 * Conservative pre-RAG gate: only true for short, unambiguous greeting/small-talk
 * so we can skip Qdrant + embeddings. When in doubt, return false (use RAG).
 */

const MAX_CHARS = 120;
const MAX_WORDS = 8;

function normalizeForMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[''\u2019`]/g, "");
}

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[!?.]+$/g, "").trim();
}

const DENY_SUBSTRINGS = [
  "http://",
  "https://",
  "{",
  "}",
  "[",
  "]",
  "`",
  "@",
] as const;

const DENY_PHRASES = [
  "how do i",
  "what is",
  "what are",
  "can you",
  "help me",
  "i need",
  "explain",
  "show me",
  "tell me",
] as const;

const DENY_WHOLE_WORDS = /\b(brs|requirement|requirements|error|api|docs?|upload|pipeline)\b/i;

/**
 * Greeting / small-talk phrases (after {@link normalizeForMatch} and
 * {@link stripTrailingPunctuation}).
 */
const ALLOWED_EXACT = new Set<string>([
  "hi",
  "hello",
  "hey",
  "howdy",
  "yo",
  "sup",
  "hiya",
  "hi there",
  "hello there",
  "hey there",
  "good morning",
  "good afternoon",
  "good evening",
  "morning",
  "afternoon",
  "evening",
  "how are you",
  "how are you doing",
  "how r u",
  "how are u",
  "hows it going",
  "whats up",
  "whats new",
  "thanks",
  "thank you",
  "thx",
  "ty",
  "ok",
  "okay",
  "k",
  "bye",
  "goodbye",
  "see you",
  "later",
  "cheers",
]);

function wordCount(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

function failsDenylist(normalized: string): boolean {
  for (const sub of DENY_SUBSTRINGS) {
    if (normalized.includes(sub)) return true;
  }
  for (const phrase of DENY_PHRASES) {
    if (normalized.includes(phrase)) return true;
  }
  if (DENY_WHOLE_WORDS.test(normalized)) return true;
  return false;
}

/**
 * Returns true only when the message is clearly greeting/small-talk (skip RAG).
 * Uses only the current user message (no history).
 */
export function shouldAnswerChatWithoutRag(message: string): boolean {
  const raw = message.trim();
  if (!raw) return false;

  if (raw.length > MAX_CHARS) return false;
  if (wordCount(raw) > MAX_WORDS) return false;

  const normalized = normalizeForMatch(raw);
  if (failsDenylist(normalized)) return false;

  const core = stripTrailingPunctuation(normalized);
  if (!core) return false;

  if (ALLOWED_EXACT.has(core)) return true;

  return false;
}

export const chatGreetingGateLimits = { MAX_CHARS, MAX_WORDS } as const;
