/**
 * `pillar db …` — database migration commands.
 *
 * These commands are thin wrappers over the `core/db` adapter layer. The
 * interesting behaviour lives in three places:
 *
 *   1. **Adapter selection** (`core/db/adapter-factory`) — picks the
 *      Prisma / Drizzle / TypeORM / Mongoose implementation based on
 *      `pillar.config.json`. Unsupported ORM × operation combinations
 *      return a typed `Unsupported` result, not an exception.
 *
 *   2. **Production safety** (this file) — destructive commands
 *      (`migrate`, `deploy`, `reset`, `rollback`) go through a central
 *      guard that checks `NODE_ENV` and requires explicit confirmation
 *      tokens for `reset`. Preview mode bypasses the guards because it
 *      never executes the command.
 *
 *   3. **Preview integration** — every command supports `--preview`,
 *      which prints the exact argv the CLI would exec plus (for Prisma
 *      only, today) a SQL diff from `prisma migrate diff`. No real DB
 *      or filesystem touch.
 */

import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, type PillarConfig } from '../core/config/index.js';
import {
  selectAdapter,
  runCommand,
  isUnsupported,
  MigrationError,
  type CommandPlan,
  type MigrationAdapter,
  type RunContext,
  type PlanResult,
} from '../core/db/index.js';
import { logger, findProjectRoot } from '../utils/index.js';
import type { PreviewFlags } from './_preview.js';
import { isPreview } from './_preview.js';

// ---------------------------------------------------------------------------
// Shared command infrastructure
// ---------------------------------------------------------------------------

interface BaseDbOptions extends PreviewFlags {
  /** Skip the confirmation prompt for destructive commands. */
  yes?: boolean;
  /** Force execution even when NODE_ENV=production. */
  forceProduction?: boolean;
}

interface RunDbOptions extends BaseDbOptions {
  /**
   * Plain operation label for telemetry / logs, e.g. "migrate".
   * Appears in error messages and the preview banner.
   */
  operation: string;
  /**
   * Resolve the adapter + context into a `PlanResult`. Kept as a callback
   * so each `pillar db <op>` command can customize plan inputs without
   * each needing its own full orchestration copy.
   */
  resolve: (adapter: MigrationAdapter, ctx: RunContext) => PlanResult;
  /**
   * Optional SQL preview — only Prisma implements this today. Called
   * only in preview mode, and only when the adapter exposes it.
   */
  previewSql?: (adapter: MigrationAdapter, ctx: RunContext) => Promise<string | null>;
  /** Required confirmation token for destructive ops (e.g., `reset`). */
  requireConfirmationToken?: string;
  confirmationProvided?: string;
}

/**
 * Shared entry point for every `pillar db <op>` subcommand.
 *
 * Flow:
 *   1. Locate the project + load config.
 *   2. Pick the adapter, build the plan.
 *   3. If the plan is `Unsupported`, print the reason + hint and exit 1.
 *   4. If `--preview`, print the command (and SQL diff, if available)
 *      and return — no exec, no guards.
 *   5. Otherwise run production + confirmation guards.
 *   6. Exec the child process; surface structured failures.
 */
async function runDbOperation(options: RunDbOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const adapter = selectAdapter(config);
  const ctx = buildRunContext(projectRoot, config);
  const plan = options.resolve(adapter, ctx);

  if (isUnsupported(plan)) {
    logger.error(`${adapter.displayName}: ${plan.reason}`, plan.hint);
    process.exitCode = 1;
    return;
  }

  if (isPreview(options)) {
    await printDbPreview(options.operation, adapter, plan, ctx, options.previewSql);
    return;
  }

  if (plan.destructive) {
    const guard = enforceProductionGuards(plan, options);
    if (!guard.ok) {
      logger.error(guard.message, guard.hint);
      process.exitCode = 1;
      return;
    }
  }

  if (options.requireConfirmationToken !== undefined) {
    if (options.confirmationProvided !== options.requireConfirmationToken) {
      logger.error(
        `This command is irreversible. Re-run with --confirm ${options.requireConfirmationToken}`,
        'The token must match the project name to prevent accidental runs in the wrong directory.',
      );
      process.exitCode = 1;
      return;
    }
  }

  logger.info(`${chalk.cyan(plan.label)}`);
  try {
    const result = await runCommand(plan, ctx);
    logger.blank();
    logger.success(`${options.operation} completed in ${(result.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err instanceof MigrationError) {
      logger.error(`${options.operation} failed`, err.stderrTail || `exit ${err.exitCode}`);
      process.exitCode = err.exitCode > 0 ? err.exitCode : 1;
      return;
    }
    throw err;
  }
}

function buildRunContext(projectRoot: string, config: PillarConfig): RunContext {
  return {
    projectRoot,
    packageManager: config.project.packageManager,
  };
}

interface GuardOk { ok: true }
interface GuardFail { ok: false; message: string; hint?: string }

/**
 * Production-safety gate for destructive commands.
 *
 *   - `migrate` / `reset` / `rollback` are refused when NODE_ENV=production
 *     unless the user explicitly passes `--force-production`. `deploy` is
 *     always allowed (it's the production path by design).
 *   - `--yes` is honored here only for telemetry; confirmation tokens
 *     (e.g., reset) are enforced separately with a stricter check.
 */
function enforceProductionGuards(plan: CommandPlan, options: BaseDbOptions): GuardOk | GuardFail {
  const nodeEnv = process.env['NODE_ENV'];
  const isProd = nodeEnv === 'production';
  if (!isProd) return { ok: true };

  // `deploy` carries `applies: true` and `destructive: true`, but it's
  // the one command designed for production. Distinguish by label.
  const isDeploy = /deploy/.test(plan.label);
  if (isDeploy) return { ok: true };

  if (options.forceProduction) return { ok: true };

  return {
    ok: false,
    message: `Refusing to run a destructive command (${plan.label}) with NODE_ENV=production`,
    hint: 'Use `pillar db deploy` for production migrations, or pass --force-production to override.',
  };
}

async function printDbPreview(
  operation: string,
  adapter: MigrationAdapter,
  plan: CommandPlan,
  ctx: RunContext,
  previewSqlFn?: (adapter: MigrationAdapter, ctx: RunContext) => Promise<string | null>,
): Promise<void> {
  logger.banner(`PREVIEW — pillar db ${operation}`);
  logger.table([
    ['ORM', adapter.displayName],
    ['Command', plan.label],
    ['argv', plan.argv.join(' ')],
    ['cwd', plan.cwd ?? ctx.projectRoot],
    ['Destructive', plan.destructive ? chalk.yellow('yes') : 'no'],
    ['Applies to DB', plan.applies ? chalk.yellow('yes') : 'no'],
  ]);

  if (previewSqlFn) {
    const sql = await previewSqlFn(adapter, ctx);
    if (sql) {
      logger.blank();
      logger.info('SQL preview (next migration):');
      logger.blank();
      process.stdout.write(indent(sql, 4) + '\n');
    } else {
      logger.blank();
      logger.info(chalk.dim('No SQL preview available (no pending changes, or preview failed).'));
    }
  }

  logger.blank();
  logger.info(chalk.dim('Nothing was executed. Re-run without --preview to apply.'));
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map((l) => (l.length === 0 ? l : pad + l)).join('\n');
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

export interface DbGenerateOptions extends BaseDbOptions { name?: string }
export interface DbMigrateOptions extends BaseDbOptions { name?: string }
export interface DbDeployOptions extends BaseDbOptions {}
export interface DbStatusOptions extends BaseDbOptions {}
export interface DbResetOptions extends BaseDbOptions { confirm?: string }
export interface DbRollbackOptions extends BaseDbOptions {}

export async function dbGenerateCommand(options: DbGenerateOptions): Promise<void> {
  await runDbOperation({
    ...options,
    operation: 'generate',
    resolve: (adapter, ctx) => adapter.planGenerate({ name: options.name }, ctx),
  });
}

export async function dbMigrateCommand(options: DbMigrateOptions): Promise<void> {
  await runDbOperation({
    ...options,
    operation: 'migrate',
    resolve: (adapter, ctx) => adapter.planMigrate({ name: options.name }, ctx),
    previewSql: (adapter, ctx) =>
      adapter.previewSql ? adapter.previewSql({ name: options.name }, ctx) : Promise.resolve(null),
  });
}

export async function dbDeployCommand(options: DbDeployOptions): Promise<void> {
  await runDbOperation({
    ...options,
    operation: 'deploy',
    resolve: (adapter, ctx) => adapter.planDeploy(ctx),
    previewSql: (adapter, ctx) =>
      adapter.previewSql ? adapter.previewSql({}, ctx) : Promise.resolve(null),
  });
}

export async function dbStatusCommand(options: DbStatusOptions): Promise<void> {
  await runDbOperation({
    ...options,
    operation: 'status',
    resolve: (adapter, ctx) => adapter.planStatus(ctx),
  });
}

export async function dbResetCommand(options: DbResetOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }
  const config = await loadConfig(projectRoot);

  await runDbOperation({
    ...options,
    operation: 'reset',
    resolve: (adapter, ctx) => adapter.planReset(ctx),
    // Require the user to type the project name as the confirmation
    // token. Cheap-to-type for the right repo; catches "wrong terminal"
    // mistakes that a bare `--yes` wouldn't.
    requireConfirmationToken: config.project.name,
    ...(options.confirm !== undefined ? { confirmationProvided: options.confirm } : {}),
  });
}

export async function dbRollbackCommand(options: DbRollbackOptions): Promise<void> {
  await runDbOperation({
    ...options,
    operation: 'rollback',
    resolve: (adapter, ctx) => adapter.planRollback(ctx),
  });
}

// ---------------------------------------------------------------------------
// pillar db seed
// ---------------------------------------------------------------------------

export interface DbSeedOptions extends BaseDbOptions {}

/**
 * `pillar db seed` — execute the project's seed runner.
 *
 * Seeding is ORM-agnostic (the runner is a plain script that calls into
 * whatever client the project uses), so this command does not go
 * through the adapter layer. It does share the surrounding behavior
 * with the other `pillar db` commands: `--preview` prints the argv
 * without executing, and the production guard refuses to run when
 * `NODE_ENV=production` unless `--force-production` is passed. Seeds
 * insert data and are therefore treated as destructive.
 *
 * The runner is discovered from the project's language setting
 * (`src/seeds/run.ts` for TypeScript, `src/seeds/run.js` otherwise) —
 * matching what `pillar seed generate` produces. If missing, we point
 * the user at the generator rather than silently doing nothing.
 */
export async function dbSeedCommand(options: DbSeedOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const ctx = buildRunContext(projectRoot, config);
  const plan = buildSeedPlan(projectRoot, config);

  if (isUnsupported(plan)) {
    logger.error(plan.reason, plan.hint);
    process.exitCode = 1;
    return;
  }

  if (isPreview(options)) {
    await printDbPreview('seed', seedAdapterStub, plan, ctx);
    return;
  }

  const guard = enforceProductionGuards(plan, options);
  if (!guard.ok) {
    logger.error(guard.message, guard.hint);
    process.exitCode = 1;
    return;
  }

  logger.info(`${chalk.cyan(plan.label)}`);
  try {
    const result = await runCommand(plan, ctx);
    logger.blank();
    logger.success(`seed completed in ${(result.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err instanceof MigrationError) {
      logger.error('seed failed', err.stderrTail || `exit ${err.exitCode}`);
      process.exitCode = err.exitCode > 0 ? err.exitCode : 1;
      return;
    }
    throw err;
  }
}

/**
 * Minimal adapter-shaped value so `printDbPreview` can label the seed
 * preview with a display name without needing an ORM-specific adapter.
 */
const seedAdapterStub = {
  orm: 'none' as const,
  displayName: 'Seed runner',
} as unknown as MigrationAdapter;

function buildSeedPlan(projectRoot: string, config: PillarConfig): PlanResult {
  const isTs = config.project.language === 'typescript';
  const relRunner = `src/seeds/run.${isTs ? 'ts' : 'js'}`;
  const absRunner = path.join(projectRoot, relRunner);

  if (!fs.pathExistsSync(absRunner)) {
    return {
      kind: 'unsupported',
      reason: `No seed runner found at ${relRunner}`,
      hint: 'Run "pillar seed generate <resource>" to scaffold one.',
    };
  }

  // `npx tsx` for TS, `node` for JS. We use the package-manager-aware
  // exec for tsx so pnpm / yarn projects don't accidentally pull down a
  // global `npx` copy; for the JS path, `node` is always on PATH.
  const argv = isTs
    ? [config.project.packageManager === 'npm' ? 'npx' : config.project.packageManager,
       ...(config.project.packageManager === 'pnpm' ? ['exec', 'tsx'] :
           config.project.packageManager === 'yarn' ? ['tsx'] :
           ['--no-install', 'tsx']),
       relRunner]
    : ['node', relRunner];

  return {
    label: `seed runner (${relRunner})`,
    argv,
    cwd: projectRoot,
    destructive: true,
    applies: true,
  };
}
