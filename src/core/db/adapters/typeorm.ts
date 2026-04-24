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
 * TypeORM migrations adapter.
 *
 * TypeORM's CLI is data-source-configuration driven: every command
 * takes `-d <data-source-path>` pointing at the file that exports the
 * DataSource. We default to the convention `src/data-source.ts`; users
 * can override via the PILLAR_DATASOURCE env var.
 *
 *   | Pillar op  | TypeORM command                              |
 *   |------------|----------------------------------------------|
 *   | generate   | typeorm migration:generate -d <ds> src/migrations/<Name> |
 *   | migrate    | typeorm migration:run -d <ds>                |
 *   | deploy     | typeorm migration:run -d <ds>                |
 *   | status     | typeorm migration:show -d <ds>               |
 *   | reset      | (unsupported — no single reset command)      |
 *   | rollback   | typeorm migration:revert -d <ds>             |
 */
export class TypeOrmAdapter implements MigrationAdapter {
  readonly orm = 'typeorm' as const;
  readonly displayName = 'TypeORM';

  planGenerate(opts: GenerateOpts, ctx: RunContext): PlanResult {
    if (!opts.name) {
      return UNSUPPORTED(
        'TypeORM migration:generate requires a name',
        'Pass --name <Name>, e.g. `pillar db generate --name AddUserRole`',
      );
    }
    const ds = dataSourcePath();
    const args = ['typeorm', 'migration:generate', '-d', ds, `src/migrations/${opts.name}`];
    return toPlan(ctx, args.join(' '), args, { destructive: false, applies: false });
  }

  planMigrate(_opts: MigrateOpts, ctx: RunContext): PlanResult {
    const args = ['typeorm', 'migration:run', '-d', dataSourcePath()];
    return toPlan(ctx, args.join(' '), args, { destructive: true, applies: true });
  }

  planDeploy(ctx: RunContext): PlanResult {
    return this.planMigrate({}, ctx);
  }

  planStatus(ctx: RunContext): PlanResult {
    const args = ['typeorm', 'migration:show', '-d', dataSourcePath()];
    return toPlan(ctx, args.join(' '), args, { destructive: false, applies: false });
  }

  planReset(_ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'TypeORM has no single reset command',
      'Drop the schema manually (or via `typeorm schema:drop`), then re-run `pillar db migrate`.',
    );
  }

  planRollback(ctx: RunContext): PlanResult {
    const args = ['typeorm', 'migration:revert', '-d', dataSourcePath()];
    return toPlan(ctx, args.join(' '), args, { destructive: true, applies: true });
  }
}

function dataSourcePath(): string {
  return process.env['PILLAR_DATASOURCE'] ?? 'src/data-source.ts';
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
