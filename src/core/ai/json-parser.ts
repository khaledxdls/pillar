/**
 * Tolerant JSON extractor for LLM responses.
 *
 * Providers routinely wrap structured output with extras that crash a naive
 * `JSON.parse`:
 *   - fenced code blocks (```json ... ```)
 *   - polite prose ("Sure! Here's the plan: { … }")
 *   - trailing commas (older GPT variants)
 *   - unicode BOM or leading whitespace
 *
 * This parser is layered:
 *   1. Trim BOM / whitespace / fences.
 *   2. Try `JSON.parse` directly — the happy path for `response_format:
 *      json_object` and tool-use responses.
 *   3. If that fails, locate the outermost `{ … }` or `[ … ]` span with
 *      balanced brace counting (string/escape aware) and parse that.
 *   4. As a last resort, strip trailing commas from the extracted span and
 *      retry.
 *
 * Every failure surfaces an error that includes a short excerpt of the
 * original payload so operators can see what the model actually sent.
 */

export class AIResponseParseError extends Error {
  constructor(message: string, public readonly raw: string) {
    const excerpt = raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
    super(`${message}\n\nModel response (excerpt):\n${excerpt}`);
    this.name = 'AIResponseParseError';
  }
}

export function parseAIJson<T = unknown>(raw: string): T {
  if (typeof raw !== 'string') {
    throw new AIResponseParseError('AI response was not a string.', String(raw));
  }

  const stripped = stripWrappers(raw);

  // Fast path.
  try {
    return JSON.parse(stripped) as T;
  } catch {
    // fall through
  }

  const span = extractJsonSpan(stripped);
  if (span) {
    try {
      return JSON.parse(span) as T;
    } catch {
      // Retry with trailing commas removed.
      try {
        return JSON.parse(stripTrailingCommas(span)) as T;
      } catch (err) {
        throw new AIResponseParseError(
          `Failed to parse JSON span from AI response: ${(err as Error).message}`,
          raw,
        );
      }
    }
  }

  throw new AIResponseParseError(
    'AI response did not contain a parseable JSON object or array.',
    raw,
  );
}

function stripWrappers(raw: string): string {
  let out = raw;
  // BOM
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.trim();

  // ```json … ``` or ``` … ``` fences (possibly with leading language tag).
  const fenceMatch = out.match(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) out = fenceMatch[1]!.trim();

  return out;
}

/**
 * Return the substring from the first `{` or `[` to its matching close,
 * ignoring braces inside strings. Returns `null` if no balanced span exists.
 */
function extractJsonSpan(content: string): string | null {
  const start = findFirstStructuralOpener(content);
  if (start === -1) return null;

  const open = content[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < content.length; i++) {
    const ch = content[i]!;

    if (escape) { escape = false; continue; }
    if (inString) {
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

function findFirstStructuralOpener(content: string): number {
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{' || ch === '[') return i;
  }
  return -1;
}

function stripTrailingCommas(span: string): string {
  // Remove `,` that precede `}` or `]`, outside of strings.
  let out = '';
  let inString = false;
  let escape = false;

  for (let i = 0; i < span.length; i++) {
    const ch = span[i]!;

    if (escape) { out += ch; escape = false; continue; }
    if (inString) {
      out += ch;
      if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }

    if (ch === ',') {
      // Look ahead for next non-whitespace.
      let j = i + 1;
      while (j < span.length && /\s/.test(span[j]!)) j++;
      const next = span[j];
      if (next === '}' || next === ']') continue; // drop comma
    }
    out += ch;
  }
  return out;
}
