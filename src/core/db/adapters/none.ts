import type { MigrationAdapter, PlanResult, RunContext } from '../types.js';
import { UNSUPPORTED } from '../types.js';

/**
 * No-ORM adapter.
 *
 * Projects initialized with `--orm none` have no migration mechanism
 * at all. Every operation returns a typed `UNSUPPORTED` with a hint
 * to pick an ORM via `pillar.config.json`.
 */
export class NoneAdapter implements MigrationAdapter {
  readonly orm = 'none' as const;
  readonly displayName = 'No ORM configured';

  planGenerate(_opts: unknown, _ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'No ORM is configured for this project',
      'Set `database.orm` in pillar.config.json to `prisma`, `drizzle`, `typeorm`, or `mongoose`.',
    );
  }

  planMigrate(_opts: unknown, ctx: RunContext): PlanResult {
    return this.planGenerate(_opts, ctx);
  }

  planDeploy(ctx: RunContext): PlanResult {
    return this.planGenerate(undefined, ctx);
  }

  planStatus(ctx: RunContext): PlanResult {
    return this.planGenerate(undefined, ctx);
  }

  planReset(ctx: RunContext): PlanResult {
    return this.planGenerate(undefined, ctx);
  }

  planRollback(ctx: RunContext): PlanResult {
    return this.planGenerate(undefined, ctx);
  }
}
