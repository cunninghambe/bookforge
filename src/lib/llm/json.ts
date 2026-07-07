// Defensive JSON extraction for model outputs. Strips code fences and pulls the
// first balanced JSON array or object out of surrounding prose, then parses. On
// failure returns { ok: false } so callers can surface the raw text instead of
// silently dropping it.

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; raw: string };

function stripFences(s: string): string {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fence ? fence[1] : s).trim();
}

// Finds the first top-level JSON value (array or object) by bracket matching so
// leading or trailing commentary does not break parsing.
function extractJson(s: string): string | null {
  const start = s.search(/[[{]/);
  if (start === -1) return null;
  const open = s[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

export function parseJson<T>(text: string): ParseResult<T> {
  const stripped = stripFences(text);
  const candidate = extractJson(stripped) ?? stripped;
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch (err) {
    return {
      ok: false,
      error: (err as Error).message,
      raw: text,
    };
  }
}
