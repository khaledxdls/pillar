/**
 * Plan / preview system public contracts.
 *
 * A `Plan` is a pure, in-memory description of the filesystem mutations a
 * command would make. It is produced by a planner function (no I/O writes),
 * and consumed by either the renderer (for `--preview`) or the executor
 * (which writes to disk and records history).
 *
 * Separating planning from execution is what makes preview mode honest:
 * the renderer prints exactly the changes the executor will apply. No
 * code path can be preview-only or execute-only; both share one source
 * of truth.
 */

export type ChangeKind = 'create' | 'modify' | 'delete' | 'move';

export interface PlannedChange {
  kind: ChangeKind;
  /** Project-relative POSIX path. */
  path: string;
  /**
   * For `move`, this is the original path (pre-move). For other kinds this
   * is undefined.
   */
  fromPath?: string;
  /**
   * Existing file content on disk, captured at plan time. Required for
   * `modify`, `delete`, and `move`; undefined for `create`.
   */
  oldContent?: string;
  /**
   * Content that will be written. Required for `create` and `modify`;
   * undefined for `delete` and `move` (unless the move also rewrites).
   */
  newContent?: string;
  /**
   * Short, human-readable description of what this change represents.
   * Appears in preview summaries and history entries.
   */
  purpose?: string;
}

export interface PlanWarning {
  /** Stable machine-readable code (e.g., `overwrite`, `no-op`, `unsafe`). */
  code: string;
  message: string;
  /** Relative path this warning concerns, if any. */
  path?: string;
}

export interface PlanSummary {
  created: number;
  modified: number;
  deleted: number;
  moved: number;
  /** Changes that are net no-ops (identical old/new content). */
  unchanged: number;
}

export interface Plan {
  /** The command that produced this plan, e.g. "add field user email:string". */
  command: string;
  changes: readonly PlannedChange[];
  warnings: readonly PlanWarning[];
  summary: PlanSummary;
  /**
   * Non-file metadata the renderer may display (e.g., a generated SQL
   * snippet for `db migrate --preview`).
   */
  notes?: readonly PlanNote[];
}

export interface PlanNote {
  title: string;
  body: string;
  /** If the body is source code, its language tag (e.g. "sql"). */
  language?: string;
}
