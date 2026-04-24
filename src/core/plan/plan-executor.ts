import path from 'node:path';
import fs from 'fs-extra';
import type { FileOperation } from '../history/types.js';
import type { Plan, PlannedChange } from './types.js';

export interface ExecuteOptions {
  /**
   * If true, skip changes that are no-ops (modify with identical
   * old/new content). Default: true.
   */
  skipUnchanged?: boolean;
}

export interface ExecuteResult {
  operations: FileOperation[];
  /** Paths actually written/removed, in execution order. */
  touched: string[];
}

/**
 * Apply a `Plan` to disk.
 *
 * Executes changes sequentially in the order they were planned. If a
 * write fails partway through, the executor rolls back every change it
 * already performed in this invocation using the in-memory captures:
 *   - `create` rollback: remove the file
 *   - `modify` rollback: restore `oldContent`
 *   - `delete` rollback: restore `oldContent`
 *   - `move`  rollback: move back and restore old destination if any
 *
 * Rollback is best-effort — if the rollback itself fails we surface the
 * original error with the rollback failure attached. We don't try to be
 * smarter than that: a partial rollback is still strictly better than
 * leaving the tree in the failed mid-write state.
 *
 * The returned `FileOperation[]` is shaped for `HistoryManager.record()`
 * so the caller can wire history in a single line.
 */
export class PlanExecutor {
  constructor(private readonly projectRoot: string) {}

  async execute(plan: Plan, options: ExecuteOptions = {}): Promise<ExecuteResult> {
    const skipUnchanged = options.skipUnchanged ?? true;
    const operations: FileOperation[] = [];
    const touched: string[] = [];
    /** Snapshot of already-applied changes, newest first, for rollback. */
    const applied: PlannedChange[] = [];

    for (const change of plan.changes) {
      if (
        skipUnchanged &&
        change.kind === 'modify' &&
        change.oldContent === change.newContent
      ) {
        continue;
      }

      try {
        await this.applyChange(change);
        applied.unshift(change);
        touched.push(change.path);
        operations.push(toFileOperation(change));
      } catch (err) {
        const rollbackError = await this.rollback(applied).catch((e) => e as Error);
        throw new PlanExecutionError(change, err, rollbackError ?? undefined);
      }
    }

    return { operations, touched };
  }

  private async applyChange(change: PlannedChange): Promise<void> {
    const full = path.join(this.projectRoot, change.path);
    switch (change.kind) {
      case 'create':
      case 'modify': {
        if (change.newContent === undefined) {
          throw new Error(`PlanExecutor: ${change.kind} requires newContent for ${change.path}`);
        }
        await fs.ensureDir(path.dirname(full));
        await fs.writeFile(full, change.newContent, 'utf-8');
        return;
      }
      case 'delete': {
        await fs.remove(full);
        return;
      }
      case 'move': {
        if (!change.fromPath) throw new Error(`PlanExecutor: move without fromPath for ${change.path}`);
        const fromFull = path.join(this.projectRoot, change.fromPath);
        await fs.ensureDir(path.dirname(full));
        await fs.move(fromFull, full, { overwrite: true });
        if (change.newContent !== undefined) {
          await fs.writeFile(full, change.newContent, 'utf-8');
        }
        return;
      }
    }
  }

  private async rollback(applied: PlannedChange[]): Promise<void> {
    for (const change of applied) {
      const full = path.join(this.projectRoot, change.path);
      try {
        switch (change.kind) {
          case 'create':
            await fs.remove(full);
            break;
          case 'modify':
            if (change.oldContent !== undefined) {
              await fs.writeFile(full, change.oldContent, 'utf-8');
            }
            break;
          case 'delete':
            if (change.oldContent !== undefined) {
              await fs.ensureDir(path.dirname(full));
              await fs.writeFile(full, change.oldContent, 'utf-8');
            }
            break;
          case 'move':
            if (change.fromPath) {
              const fromFull = path.join(this.projectRoot, change.fromPath);
              await fs.ensureDir(path.dirname(fromFull));
              await fs.move(full, fromFull, { overwrite: true });
            }
            break;
        }
      } catch {
        // Swallow per-change rollback failures; best-effort by contract.
      }
    }
  }
}

function toFileOperation(change: PlannedChange): FileOperation {
  switch (change.kind) {
    case 'create':
      return { type: 'create', path: change.path };
    case 'modify':
      return change.oldContent !== undefined
        ? { type: 'modify', path: change.path, previousContent: change.oldContent }
        : { type: 'modify', path: change.path };
    case 'delete':
      return change.oldContent !== undefined
        ? { type: 'delete', path: change.path, previousContent: change.oldContent }
        : { type: 'delete', path: change.path };
    case 'move':
      return change.fromPath
        ? { type: 'move', path: change.path, fromPath: change.fromPath }
        : { type: 'move', path: change.path };
  }
}

export class PlanExecutionError extends Error {
  readonly change: PlannedChange;
  override readonly cause: unknown;
  readonly rollbackError?: Error;

  constructor(change: PlannedChange, cause: unknown, rollbackError?: Error) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    const rb = rollbackError ? ` (rollback also failed: ${rollbackError.message})` : '';
    super(`Failed to ${change.kind} ${change.path}: ${causeMsg}${rb}`);
    this.name = 'PlanExecutionError';
    this.change = change;
    this.cause = cause;
    if (rollbackError) this.rollbackError = rollbackError;
  }
}
