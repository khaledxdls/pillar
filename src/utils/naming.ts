/**
 * Shared naming utilities. Used across generators, extensions, and docs so
 * that a hyphenated resource like `user-profile` produces a single,
 * consistent PascalCase (`UserProfile`) and plural (`userProfiles`) form.
 *
 * Keeping this logic in one place prevents drift: historically each module
 * re-implemented naming with `name.charAt(0).toUpperCase() + name.slice(1)`,
 * which silently broke for any identifier containing `-` or `_`.
 */

/** Split a name into word parts on `-`, `_`, spaces, and camelCase boundaries. */
function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s\-_]+/)
    .filter(Boolean);
}

export function toPascalCase(name: string): string {
  return splitWords(name)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

export function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toKebabCase(name: string): string {
  return splitWords(name).map((w) => w.toLowerCase()).join('-');
}

/**
 * Pluralize a single English word. Handles the common irregular forms that
 * show up in real resource names (person → people, child → children, etc.)
 * and the regular y/ies, s/es, ss/sses patterns. For anything unknown it
 * falls back to appending `s`.
 *
 * We don't pull in a full inflector (`pluralize`, `inflection`) to keep
 * runtime deps minimal — this covers the 95% case for scaffolded resources.
 */
const IRREGULAR_PLURALS: Record<string, string> = {
  person: 'people',
  child: 'children',
  man: 'men',
  woman: 'women',
  mouse: 'mice',
  goose: 'geese',
  foot: 'feet',
  tooth: 'teeth',
  ox: 'oxen',
  datum: 'data',
  medium: 'media',
  analysis: 'analyses',
  index: 'indices',
  matrix: 'matrices',
  vertex: 'vertices',
};

const UNCOUNTABLE = new Set([
  'equipment', 'information', 'rice', 'money', 'species',
  'series', 'fish', 'sheep', 'deer', 'news',
]);

export function pluralize(word: string): string {
  if (!word) return word;
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR_PLURALS[lower]) return preserveCase(word, IRREGULAR_PLURALS[lower]!);

  // -y preceded by consonant → -ies
  if (/[^aeiou]y$/i.test(word)) return word.slice(0, -1) + 'ies';
  // -s, -x, -z, -ch, -sh → -es
  if (/(s|x|z|ch|sh)$/i.test(word)) return word + 'es';
  // -f / -fe → -ves (leaf → leaves, knife → knives)
  if (/fe$/i.test(word)) return word.slice(0, -2) + 'ves';
  if (/[^f]f$/i.test(word)) return word.slice(0, -1) + 'ves';

  return word + 's';
}

function preserveCase(original: string, replacement: string): string {
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original[0] === original[0]!.toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Produce the plural form of a resource identifier, preserving its case
 * convention. Hyphenated names get their final segment pluralized:
 * `user-profile` → `user-profiles`, `Child` → `Children`.
 */
export function pluralizeResource(name: string): string {
  if (name.includes('-')) {
    const parts = name.split('-');
    const last = parts.pop()!;
    return [...parts, pluralize(last)].join('-');
  }
  return pluralize(name);
}

/**
 * Locate a top-level TypeScript interface block by name and return its
 * offsets, correctly handling nested braces (e.g. `settings: { theme: string }`
 * or inline object literals). Returns `null` if the interface is not found.
 *
 * Offsets are absolute within `content`:
 *   - openBrace:  the `{` that opens the interface body
 *   - closeBrace: the matching `}` that closes it
 *
 * A regex with `\{[^}]*\}` cannot do this — it terminates at the first inner
 * `}` and corrupts the surrounding file when used as a replacement target.
 */
export interface InterfaceBlock {
  openBrace: number;
  closeBrace: number;
  body: string;
}

export function findInterfaceBlock(content: string, interfaceName: string): InterfaceBlock | null {
  const header = new RegExp(
    `export\\s+interface\\s+${escapeForRegex(interfaceName)}\\b[^{]*\\{`,
  );
  const match = header.exec(content);
  if (!match) return null;

  const openBrace = match.index + match[0].length - 1;
  const closeBrace = findMatchingBrace(content, openBrace);
  if (closeBrace === -1) return null;

  return {
    openBrace,
    closeBrace,
    body: content.slice(openBrace + 1, closeBrace),
  };
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i]!;
    const prev = i > 0 ? content[i - 1] : '';

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '/' && prev === '*') inBlockComment = false;
      continue;
    }
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }

    if (ch === '/' && content[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === '/' && content[i + 1] === '*') { inBlockComment = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
