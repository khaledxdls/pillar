/**
 * Database-migrations public contracts.
 *
 * A `MigrationAdapter` is a small, uniform facade over an ORM's native
 * migration CLI. Each adapter produces `CommandPlan`s — declarative
 * descriptions of what the CLI would execute — and the `runner` module
 * turns plans into real child processes. Separating planning from
 * execution is what lets `pillar db … --preview` show exactly the
 * command (and, where supported, the SQL) a real run would produce.
 *
 * An adapter that cannot support an operation returns `UNSUPPORTED` with
 * a hint, instead of throwing. Commands surface the hint to the user
 * and exit non-zero. This preserves symmetry: every command-adapter
 * cell in the matrix resolves to either a runnable plan or a typed
 * "not supported — here's why" value.
 */

import type { Orm } from '../../utils/constants.js';

export interface RunContext {
  projectRoot: string;
  /** Package manager to use for `npx` / `yarn dlx` / `pnpm dlx`. */
  packageManager: 'npm' | 'yarn' | 'pnpm';
  /** Absolute path for spawn `cwd`. Defaults to `projectRoot`. */
  cwd?: string;
  /**
   * NODE_ENV override passed into the child env. Important for Prisma
   * / Drizzle which treat prod vs dev differently. Leave undefined to
   * inherit from process.env.
   */
  nodeEnv?: string;
}

export interface GenerateOpts {
  /**
   * Migration name slug. Adapters normalize this (Prisma snake_cases it).
   * Required for most adapters; TypeORM accepts it as a Class name.
   */
  name?: string;
}

export type MigrateOpts = GenerateOpts;

export interface CommandPlan {
  /** Human-readable label shown in preview output. */
  label: string;
  /** argv as it will be spawned. `argv[0]` is the executable. */
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * `true` when the command mutates schema or data destructively
   * (migrate, deploy, reset, rollback). The CLI uses this to gate the
   * production-safety confirmation layer.
   */
  destructive: boolean;
  /**
   * `true` when the command applies changes to the database. `deploy`
   * and `migrate` are applied; `generate` is not. Used by CLI gates.
   */
  applies: boolean;
}

export interface Unsupported {
  readonly kind: 'unsupported';
  /** Short human-readable reason; printed as the error message. */
  reason: string;
  /** Actionable next step the user can take, shown as a hint. */
  hint?: string;
}

export const UNSUPPORTED = (reason: string, hint?: string): Unsupported => ({
  kind: 'unsupported',
  reason,
  ...(hint !== undefined ? { hint } : {}),
});

export type PlanResult = CommandPlan | Unsupported;

export function isUnsupported(p: PlanResult): p is Unsupported {
  return (p as Unsupported).kind === 'unsupported';
}

export interface MigrationAdapter {
  readonly orm: Orm;
  /** Display name used in logs and error messages. */
  readonly displayName: string;

  planGenerate(opts: GenerateOpts, ctx: RunContext): PlanResult;
  planMigrate(opts: MigrateOpts, ctx: RunContext): PlanResult;
  planDeploy(ctx: RunContext): PlanResult;
  planStatus(ctx: RunContext): PlanResult;
  planReset(ctx: RunContext): PlanResult;
  planRollback(ctx: RunContext): PlanResult;

  /**
   * Optional: compute the SQL the next migration would generate, without
   * creating a file or touching the DB. Used by `--preview` to show a
   * real SQL diff instead of just the command that would run.
   *
   * Returns `null` when no SQL preview is available (e.g., no pending
   * schema changes) or when the adapter can't compute one.
   */
  previewSql?(opts: MigrateOpts, ctx: RunContext): Promise<string | null>;
}

export interface RunResult {
  exitCode: number;
  /** Captured stdout. Empty when streaming was enabled. */
  stdout: string;
  /** Captured stderr. Empty when streaming was enabled. */
  stderr: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
}

/**
 * Error class for adapter / runner failures. Wraps exit code + the tail
 * of stderr so the CLI can surface a useful message without printing
 * the entire log twice.
 */
export class MigrationError extends Error {
  readonly exitCode: number;
  readonly stderrTail: string;
  readonly command: string;

  constructor(command: string, exitCode: number, stderrTail: string) {
    super(`Migration command failed (${command}): exit ${exitCode}`);
    this.name = 'MigrationError';
    this.exitCode = exitCode;
    this.stderrTail = stderrTail;
    this.command = command;
  }
}
