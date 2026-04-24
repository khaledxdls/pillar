/**
 * Post-schema-edit migration hook.
 *
 * When `config.database.migrations.autoGenerateOnFieldAdd` is true, a
 * successful `pillar add field` / `pillar add relation` also runs
 * `pillar db generate` under the hood so the schema edit is paired
 * with a migration in a single command. Opt-in — the default is off
 * because migrations are durable artifacts and should remain an
 * explicit user action for most workflows.
 *
 * Non-fatal by design: if the migration generator fails (missing CLI,
 * misconfigured data source, shadow DB not ready), the schema edit
 * has already succeeded and is recorded in history. We surface the
 * failure clearly and tell the user exactly which command to re-run,
 * rather than unwinding the add.
 */

import chalk from 'chalk';
import type { PillarConfig } from '../core/config/index.js';
import {
  selectAdapter,
  runCommand,
  isUnsupported,
  MigrationError,
  type RunContext,
} from '../core/db/index.js';
import { logger } from '../utils/index.js';

export interface AutoMigrationContext {
  /** Absolute project root, as returned by `findProjectRoot`. */
  projectRoot: string;
  config: PillarConfig;
  /**
   * Short identifier used to build the migration name slug — e.g. the
   * resource name for `add field`, or `<source>_<target>_<type>` for
   * `add relation`. The caller shapes this; the hook only sanitizes.
   */
  subject: string;
  /** Discriminator for the name prefix (`add_fields_`, `add_relation_`). */
  reason: 'field' | 'relation';
  /**
   * When true, the hook describes what *would* run and returns without
   * executing. Used to integrate with the `--preview` flag on the
   * calling command — keeps preview mode pure.
   */
  preview?: boolean;
}

export async function maybeAutoGenerateMigration(ctx: AutoMigrationContext): Promise<void> {
  const enabled = ctx.config.database.migrations?.autoGenerateOnFieldAdd === true;
  if (!enabled) return;

  const adapter = selectAdapter(ctx.config);
  const runCtx: RunContext = {
    projectRoot: ctx.projectRoot,
    packageManager: ctx.config.project.packageManager,
  };

  const name = buildMigrationSlug(ctx.reason, ctx.subject);
  const plan = adapter.planGenerate({ name }, runCtx);

  if (isUnsupported(plan)) {
    // ORM has no matching operation (e.g., Mongoose, or Drizzle can't
    // use the slug we computed). Surface the adapter's reason verbatim
    // so the message matches what `pillar db generate` would print.
    logger.blank();
    logger.warn(
      `auto-migration skipped — ${adapter.displayName}: ${plan.reason}`,
    );
    if (plan.hint) logger.info(chalk.dim(plan.hint));
    return;
  }

  if (ctx.preview) {
    logger.blank();
    logger.info(
      `autoGenerateOnFieldAdd=true — would also run: ${chalk.cyan(plan.label)}`,
    );
    return;
  }

  logger.blank();
  logger.info(`auto-migration: ${chalk.cyan(plan.label)}`);
  try {
    const result = await runCommand(plan, runCtx);
    logger.success(
      `auto-migration generated in ${(result.durationMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    const detail =
      err instanceof MigrationError
        ? err.stderrTail || `exit ${err.exitCode}`
        : err instanceof Error
          ? err.message
          : String(err);
    logger.blank();
    logger.warn(`auto-migration failed — the schema edit succeeded and is in history.`);
    logger.error(detail, `Re-run manually: pillar db generate --name ${name}`);
    // Non-zero exit so CI surfaces the failure, but we do not throw:
    // the add was recorded and should not be treated as rolled back.
    process.exitCode = 1;
  }
}

/**
 * Produce a deterministic, CLI-safe migration name slug.
 *
 *   field:    `add_<subject>_fields`
 *   relation: `add_<subject>_relation`
 *
 * The subject is lowercased, non-alphanumerics collapsed to `_`, and
 * leading/trailing separators stripped. Length is capped at 60 chars —
 * Prisma accepts longer, but 60 is more than enough for a filesystem
 * path segment and keeps `prisma/migrations/<timestamp>_<name>/` tidy.
 */
export function buildMigrationSlug(
  reason: AutoMigrationContext['reason'],
  subject: string,
): string {
  const cleaned = subject
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  const base = cleaned.length > 0 ? cleaned : 'change';
  const suffix = reason === 'field' ? '_fields' : '_relation';
  const slug = `add_${base}${suffix}`;
  return slug.length > 60 ? slug.slice(0, 60).replace(/_+$/, '') : slug;
}
