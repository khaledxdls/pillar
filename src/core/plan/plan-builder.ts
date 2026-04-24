import path from 'node:path';
import fs from 'fs-extra';
import type { Plan, PlannedChange, PlanNote, PlanSummary, PlanWarning } from './types.js';

/**
 * Accumulator for building a `Plan`.
 *
 * Invariants the builder enforces:
 *   - Paths are normalized to POSIX-style, project-relative.
 *   - A given path can appear at most once (the last write wins would be
 *     confusing in a diff — instead we refuse and force the caller to
 *     merge intent). A second call for the same path throws.
 *   - No-op modifications (oldContent === newContent) are kept but flagged
 *     in `summary.unchanged` so the renderer can suppress them.
 *
 * The builder itself performs no filesystem writes. It may read from disk
 * via `captureExisting()` to populate `oldContent` — this is I/O but
 * read-only and idempotent, and keeping it here means every caller gets
 * the same "plan against current disk state" semantics.
 */
export class PlanBuilder {
  private readonly projectRoot: string;
  private readonly command: string;
  private readonly changes: PlannedChange[] = [];
  private readonly warnings: PlanWarning[] = [];
  private readonly notes: PlanNote[] = [];
  private readonly seenPaths = new Set<string>();

  constructor(projectRoot: string, command: string) {
    this.projectRoot = projectRoot;
    this.command = command;
  }

  /**
   * Read the current contents of `relativePath` from disk, if present.
   * Returns undefined for missing files. Callers use this to populate
   * `oldContent` on a `modify` or `delete` change.
   */
  async captureExisting(relativePath: string): Promise<string | undefined> {
    const full = path.join(this.projectRoot, relativePath);
    if (!(await fs.pathExists(full))) return undefined;
    const stat = await fs.stat(full);
    if (!stat.isFile()) return undefined;
    return fs.readFile(full, 'utf-8');
  }

  /**
   * Plan the creation of a new file. If the file already exists, the
   * change is recorded as a `modify` against the existing contents so
   * the preview shows an accurate diff rather than a misleading "new
   * file" banner.
   */
  async create(relativePath: string, newContent: string, purpose?: string): Promise<void> {
    const normalized = normalizePath(relativePath);
    this.assertUnique(normalized);

    const existing = await this.captureExisting(normalized);
    if (existing === undefined) {
      this.changes.push({ kind: 'create', path: normalized, newContent, purpose });
      return;
    }
    this.changes.push({
      kind: 'modify',
      path: normalized,
      oldContent: existing,
      newContent,
      purpose,
    });
    this.warn({
      code: 'overwrite',
      path: normalized,
      message: `File exists and will be overwritten`,
    });
  }

  /**
   * Plan a modification. Callers supply the new content; old content is
   * read from disk here. If the file doesn't exist, this is recorded as
   * a `create` instead, with a warning — most planners shouldn't hit
   * this branch, but it keeps the builder robust against stale caller
   * assumptions.
   */
  async modify(relativePath: string, newContent: string, purpose?: string): Promise<void> {
    const normalized = normalizePath(relativePath);
    this.assertUnique(normalized);

    const existing = await this.captureExisting(normalized);
    if (existing === undefined) {
      this.changes.push({ kind: 'create', path: normalized, newContent, purpose });
      this.warn({
        code: 'missing-target',
        path: normalized,
        message: 'Modify target did not exist; planning a create instead',
      });
      return;
    }
    this.changes.push({
      kind: 'modify',
      path: normalized,
      oldContent: existing,
      newContent,
      purpose,
    });
  }

  async delete(relativePath: string, purpose?: string): Promise<void> {
    const normalized = normalizePath(relativePath);
    this.assertUnique(normalized);

    const existing = await this.captureExisting(normalized);
    if (existing === undefined) {
      this.warn({
        code: 'no-op-delete',
        path: normalized,
        message: 'Delete target does not exist; skipping',
      });
      return;
    }
    this.changes.push({ kind: 'delete', path: normalized, oldContent: existing, purpose });
  }

  async move(fromPath: string, toPath: string, newContent?: string, purpose?: string): Promise<void> {
    const from = normalizePath(fromPath);
    const to = normalizePath(toPath);
    if (from === to) {
      this.warn({ code: 'no-op-move', path: from, message: 'Move source and destination are identical' });
      return;
    }
    this.assertUnique(to);

    const existing = await this.captureExisting(from);
    this.changes.push({
      kind: 'move',
      path: to,
      fromPath: from,
      oldContent: existing,
      newContent,
      purpose,
    });
  }

  warn(w: PlanWarning): void {
    this.warnings.push(w);
  }

  note(n: PlanNote): void {
    this.notes.push(n);
  }

  /**
   * Produce the immutable `Plan`. Callers should treat the result as
   * read-only; the builder is single-use after `build()` returns.
   */
  build(): Plan {
    const summary = computeSummary(this.changes);
    return {
      command: this.command,
      changes: Object.freeze([...this.changes]),
      warnings: Object.freeze([...this.warnings]),
      summary,
      notes: this.notes.length > 0 ? Object.freeze([...this.notes]) : undefined,
    };
  }

  /**
   * Number of changes accumulated so far. Used by callers to short-circuit
   * empty-plan cases (e.g., "resource already up to date").
   */
  get size(): number {
    return this.changes.length;
  }

  private assertUnique(p: string): void {
    if (this.seenPaths.has(p)) {
      throw new Error(`PlanBuilder: path planned twice: ${p}`);
    }
    this.seenPaths.add(p);
  }
}

function normalizePath(p: string): string {
  return p.split(path.sep).join('/').replace(/^\.\//, '');
}

function computeSummary(changes: PlannedChange[]): PlanSummary {
  let created = 0;
  let modified = 0;
  let deleted = 0;
  let moved = 0;
  let unchanged = 0;

  for (const c of changes) {
    switch (c.kind) {
      case 'create':
        created++;
        break;
      case 'modify':
        if (c.oldContent === c.newContent) unchanged++;
        else modified++;
        break;
      case 'delete':
        deleted++;
        break;
      case 'move':
        moved++;
        break;
    }
  }

  return { created, modified, deleted, moved, unchanged };
}
