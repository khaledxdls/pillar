import type { MigrationAdapter, PlanResult, RunContext } from '../types.js';
import { UNSUPPORTED } from '../types.js';

/**
 * Mongoose "adapter".
 *
 * Mongoose has no built-in migration framework — schema changes in
 * MongoDB are usually handled via document-level code paths, not a
 * CLI. Rather than pretend, every operation returns a typed
 * `UNSUPPORTED` that points the user at `migrate-mongo` (the de-facto
 * community tool) with a short integration hint.
 *
 * The CLI surfaces these hints verbatim, so this file doubles as the
 * single place we document Pillar's Mongoose migration story.
 */
export class MongooseAdapter implements MigrationAdapter {
  readonly orm = 'mongoose' as const;
  readonly displayName = 'Mongoose';

  planGenerate(_opts: unknown, _ctx: RunContext): PlanResult {
    return UNSUPPORTED(
      'Mongoose does not provide a native migration CLI',
      'Install `migrate-mongo` and run `migrate-mongo create <name>`; or manage schema drift in application code.',
    );
  }

  planMigrate(_opts: unknown, _ctx: RunContext): PlanResult {
    return this.planGenerate(_opts, _ctx);
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
