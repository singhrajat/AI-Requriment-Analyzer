/**
 * Pretty-print JSON from model output: strips common ```json fences and
 * extracts a balanced {...} or [...] slice when extra prose wraps the payload.
 */
export function formatJsonLikeOutput(raw: string): string {
  const parsed = parseJsonLikeOutput(raw);
  if (parsed !== null) {
    return JSON.stringify(parsed, null, 2);
  }
  return raw.trim();
}

/**
 * Parse JSON from model output (fences, surrounding prose). Returns null if not valid JSON.
 */
export function parseJsonLikeOutput(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidate = stripMarkdownFence(trimmed);
  const direct = tryParseJson(candidate);
  if (direct !== null) return direct;

  const objSlice = extractBalancedJson(candidate, "{", "}");
  if (objSlice) {
    const o = tryParseJson(objSlice);
    if (o !== null) return o;
  }

  const arrSlice = extractBalancedJson(candidate, "[", "]");
  if (arrSlice) {
    const a = tryParseJson(arrSlice);
    if (a !== null) return a;
  }

  return null;
}

function tryParseJson(s: string): unknown | null {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

function stripMarkdownFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]+?)```/);
  return m ? m[1].trim() : s;
}

function extractBalancedJson(
  s: string,
  open: "{" | "[",
  close: "}" | "]"
): string | null {
  const start = s.indexOf(open);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
