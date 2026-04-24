import type {
  MigrationAdapter,
  MigrateOpts,
  GenerateOpts,
  PlanResult,
  RunContext,
} from '../types.js';
import { UNSUPPORTED } from '../types.js';
import { packageManagerExec } from '../runner.js';

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
