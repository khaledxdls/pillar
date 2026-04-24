import path from 'node:path';
import fs from 'fs-extra';

/**
 * Shared migration-file reader used by adapters that compute SQL
 * previews by inspecting files on disk rather than invoking a CLI.
 *
 * Semantics: list files in `dir` (non-recursive), filter by
 * `extensions`, sort lexicographically (both drizzle-kit and TypeORM
 * encode a monotonic timestamp / sequence at the start of each
 * filename, so lexical order == apply order), read each one, and
 * concatenate with a header that identifies the file. Returns `null`
 * when there is nothing to preview so callers can distinguish "no
 * pending changes" from "preview unavailable".
 *
 * Output is capped: we truncate per-file at `maxBytesPerFile` and the
 * combined output at `maxTotalBytes` so a migration with a big data
 * backfill doesn't flood the terminal. Truncation is marked inline.
 */
export interface ReadPendingOptions {
  /** File extensions to include (e.g., `['.sql']`, `['.ts', '.js']`). */
  extensions: string[];
  /** Max bytes per individual file; longer files are truncated with a marker. */
  maxBytesPerFile?: number;
  /** Max total bytes across all files; overflow is truncated. */
  maxTotalBytes?: number;
}

const DEFAULT_MAX_PER_FILE = 8 * 1024;
const DEFAULT_MAX_TOTAL = 32 * 1024;

export async function readPendingMigrationSql(
  dir: string,
  options: ReadPendingOptions,
): Promise<string | null> {
  if (!(await fs.pathExists(dir))) return null;
  const stat = await fs.stat(dir);
  if (!stat.isDirectory()) return null;

  const exts = options.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`));
  const maxPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL;

  const entries = await fs.readdir(dir);
  const files = entries
    .filter((name) => exts.some((ext) => name.toLowerCase().endsWith(ext)))
    .sort();

  if (files.length === 0) return null;

  const chunks: string[] = [];
  let total = 0;

  for (const name of files) {
    const abs = path.join(dir, name);
    const fstat = await fs.stat(abs);
    if (!fstat.isFile()) continue;

    let body = await fs.readFile(abs, 'utf-8');
    let truncatedFile = false;
    if (body.length > maxPerFile) {
      body = body.slice(0, maxPerFile);
      truncatedFile = true;
    }

    const header = `-- ${name}`;
    const rendered = truncatedFile
      ? `${header}\n${body}\n-- (truncated — file larger than ${maxPerFile} bytes)`
      : `${header}\n${body}`;

    if (total + rendered.length > maxTotal) {
      const remaining = files.length - chunks.length;
      chunks.push(`-- (${remaining} more file(s) omitted — combined output exceeds ${maxTotal} bytes)`);
      break;
    }

    chunks.push(rendered);
    total += rendered.length + 1;
  }

  return chunks.length === 0 ? null : chunks.join('\n\n');
}
