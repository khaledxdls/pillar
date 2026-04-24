import path from 'node:path';
import fs from 'fs-extra';
import type {
  MigrationAdapter,
  MigrateOpts,
  GenerateOpts,
  PlanResult,
  RunContext,
} from '../types.js';
import { UNSUPPORTED } from '../types.js';
import { packageManagerExec } from '../runner.js';
import { readPendingMigrationSql } from './preview-files.js';

/**
 * Drizzle migrations adapter.
 *
 * Maps to `drizzle-kit` subcommands. Drizzle splits the workflow cleanly:
 *
 *   | Pillar op  | drizzle-kit command                   |
 *   |------------|---------------------------------------|
 *   | generate   | drizzle-kit generate [--name X]       |
 *   | migrate    | drizzle-kit migrate                   |
 *   | deploy     | drizzle-kit migrate                   |
 *   | status     | (unsupported — no native status)      |
 *   | reset      | drizzle-kit drop + drizzle-kit migrate |
 *   | rollback   | (unsupported — no native rollback)    |
 *
 * The `migrate` and `deploy` commands intentionally map to the same
 * `drizzle-kit migrate` invocation. Drizzle doesn't distinguish dev vs
 * prod at the CLI level; the separation here is for the Pillar
 * production-safety layer (different guards on top of the same op).
 */
export class DrizzleAdapter implements MigrationAdapter {
  readonly orm = 'drizzle' as const;
  readonly displayName = 'Drizzle';

  planGenerate(opts: GenerateOpts, ctx: RunContext): PlanResult {
    const args = ['drizzle-kit', 'generate'];
    if (opts.name) args.push('--name', opts.name);
    return toPlan(ctx, labelOf(args), args, { destructive: false, applies: false });
  }

  planMigrate(_opts: MigrateOpts, ctx: RunContext): PlanResult {
    const args = ['drizzle-kit', 'migrate'];
    return toPlan(ctx, labelOf(args), args, { destructive: true, applies: true });
  }

  planDeploy(ctx: RunContext): PlanResult {
    // Same underlying command as migrate; the difference is which
    // Pillar safety guards apply (deploy = production-ready).
    return this.planMigrate({}, ctx);
  }

  planStatus(_ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'Drizzle has no migration status command',
      'Inspect your drizzle migrations directory or your database\'s migration table directly.',
    );
  }

  planReset(_ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'Drizzle has no single reset command',
      'Use `drizzle-kit drop` to discard schema changes, then re-run `pillar db migrate`.',
    );
  }

  planRollback(_ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'Drizzle does not support migration rollbacks',
      'Write a new migration that reverses the change.',
    );
  }

  /**
   * Drizzle preview: show SQL that `drizzle-kit migrate` would apply next.
   *
   * `drizzle-kit` has no native dry-run for `migrate`, and the set of
   * "pending" migrations is authoritative only via the DB's
   * `__drizzle_migrations` table. Without DB access we can only give a
   * conservative view: every `.sql` file on disk in journal order, which
   * `drizzle-kit migrate` will apply in the same order (skipping any
   * already recorded).
   *
   * The out directory resolution mirrors drizzle-kit's own defaults:
   *   1. `PILLAR_DRIZZLE_OUT` env override (useful when drizzle.config
   *      has a non-default `out` path we can't parse from TS).
   *   2. `drizzle/` (the drizzle-kit default).
   *   3. `src/drizzle/` (common convention for `src/`-rooted projects).
   */
  async previewSql(_opts: MigrateOpts, ctx: RunContext): Promise<string | null> {
    const outDir = await resolveDrizzleOutDir(ctx.projectRoot);
    if (!outDir) return null;
    return readPendingMigrationSql(outDir, { extensions: ['.sql'] });
  }
}

async function resolveDrizzleOutDir(projectRoot: string): Promise<string | null> {
  const override = process.env['PILLAR_DRIZZLE_OUT'];
  const candidates = [
    ...(override ? [override] : []),
    'drizzle',
    path.join('src', 'drizzle'),
  ];
  for (const rel of candidates) {
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (await fs.pathExists(abs)) return abs;
  }
  return null;
}

function labelOf(args: string[]): string {
  return args.join(' ');
}

function toPlan(
  ctx: RunContext,
  label: string,
  argv: string[],
  flags: { destructive: boolean; applies: boolean },
): PlanResult {
  const [bin, ...rest] = argv;
  if (!bin) return UNSUPPORTED('internal: empty argv');
  const exec = packageManagerExec(ctx.packageManager, bin, rest);
  return {
    label,
    argv: exec.argv,
    cwd: ctx.cwd ?? ctx.projectRoot,
    destructive: flags.destructive,
    applies: flags.applies,
  };
}
