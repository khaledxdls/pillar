import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, type PillarConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { ObservabilityGenerator } from '../core/observability/index.js';
import { EnvManager } from '../core/env/index.js';
import { addElementToDecoratorArray, addModuleStatement, ensureNamedImport } from '../core/ast/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface AddObservabilityOptions {
  dryRun?: boolean;
  force?: boolean;
  /** Skip package.json / env / app wiring — emit files only. */
  filesOnly?: boolean;
}

/**
 * `pillar add observability` — scaffold a complete logging + request-id +
 * health + error-handling module.
 *
 * Scope:
 *   - Emits 5–7 files (request-context, logger, request-id, http-logger,
 *     error-handler, health, plus a Nest module / Next route handlers
 *     where applicable) tailored to the project's stack + architecture.
 *   - Adds `pino` (and `pino-pretty` as devDep) to package.json.
 *   - Adds `LOG_LEVEL` + `LOG_PRETTY` to .env.example and .env.
 *   - Wires observability into the app entry (Express/Fastify/Hono),
 *     the AppModule (NestJS), or relies on file-based routing (Next.js).
 *   - Records every mutation in history so `pillar undo` reverses the
 *     entire scaffold in one step.
 */
export async function addObservabilityCommand(options: AddObservabilityOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);

  let generated;
  try {
    generated = new ObservabilityGenerator(config).generate();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { files, dependencies, devDependencies, envKeys } = generated;

  if (options.dryRun) {
    logger.banner('Dry Run — Observability Scaffold');
    logger.info(`Stack: ${chalk.cyan(config.project.stack)}`);
    logger.info(`Architecture: ${chalk.cyan(config.project.architecture)}`);
    logger.blank();
    logger.info(`Files (${files.length}):`);
    for (const f of files) {
      const exists = await fs.pathExists(path.join(projectRoot, f.relativePath));
      const tag = exists ? chalk.yellow('(exists)') : chalk.green('(new)');
      console.log(`  ${chalk.dim('→')} ${f.relativePath} ${tag}`);
      console.log(`    ${chalk.dim(f.purpose)}`);
    }
    logger.blank();
    logger.info('Dependencies to add:');
    logger.list([
      ...Object.entries(dependencies).map(([k, v]) => `${k}@${v}`),
      ...Object.entries(devDependencies).map(([k, v]) => `${k}@${v} (dev)`),
    ]);
    logger.blank();
    logger.info('Env keys to add:');
    logger.list(envKeys.map((e) => `${e.key} — ${e.comment}`));
    return;
  }

  if (!options.force) {
    const conflicts: string[] = [];
    for (const f of files) {
      if (await fs.pathExists(path.join(projectRoot, f.relativePath))) conflicts.push(f.relativePath);
    }
    if (conflicts.length > 0) {
      logger.error('Files already exist:');
      logger.list(conflicts);
      logger.blank();
      logger.info('Use --force to overwrite, or --dry-run to preview.');
      process.exitCode = 1;
      return;
    }
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Scaffolding observability (${files.length} files)`, async () => {
    for (const f of files) {
      const fullPath = path.join(projectRoot, f.relativePath);
      const exists = await fs.pathExists(fullPath);
      const previousContent = exists ? await fs.readFile(fullPath, 'utf-8') : undefined;
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, f.content, 'utf-8');
      operations.push({
        type: exists ? 'modify' : 'create',
        path: f.relativePath,
        ...(previousContent !== undefined ? { previousContent } : {}),
      });
    }
  });

  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    for (const f of files) {
      await mapManager.registerEntry(f.relativePath, f.purpose);
    }
    logger.info('Project map updated');
  }

  if (!options.filesOnly) {
    const pkgOp = await updatePackageJson(projectRoot, dependencies, devDependencies);
    if (pkgOp) operations.push(pkgOp);

    const envOps = await updateEnvFiles(projectRoot, envKeys);
    operations.push(...envOps);

    const wireOp = await wireObservabilityIntoApp(projectRoot, config);
    if (wireOp) operations.push(wireOp);
  }

  const history = new HistoryManager(projectRoot);
  await history.record('add observability', operations);

  logger.blank();
  logger.success('Observability scaffold generated');
  logger.blank();
  logger.info('Files created:');
  logger.list(files.map((f) => f.relativePath));
  logger.blank();
  logger.info('Next steps:');
  logger.list([
    `Install deps: ${chalk.cyan('npm install')}`,
    `Tune ${chalk.cyan('LOG_LEVEL')} in .env (default: info). Set ${chalk.cyan('LOG_PRETTY=true')} for dev.`,
    'Use logger() inside request handlers — it returns a child bound to the current requestId.',
    config.project.stack === 'express' || config.project.stack === 'fastify' || config.project.stack === 'hono'
      ? 'If your app.ts had an inline /health route, remove it — the observability router now owns /health and /ready.'
      : 'GET /health and GET /ready are now served (Next: /api/health, /api/ready).',
  ]);
  logger.blank();
}

// ---------------------------------------------------------------------------
// package.json + env helpers (mirror commands/auth.ts)
// ---------------------------------------------------------------------------

async function updatePackageJson(
  projectRoot: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): Promise<FileOperation | null> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(pkgPath))) return null;

  const previousContent = await fs.readFile(pkgPath, 'utf-8');
  const pkg = JSON.parse(previousContent) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };

  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};

  let changed = false;
  for (const [k, v] of Object.entries(deps)) {
    if (!pkg.dependencies[k]) { pkg.dependencies[k] = v; changed = true; }
  }
  for (const [k, v] of Object.entries(devDeps)) {
    if (!pkg.devDependencies[k]) { pkg.devDependencies[k] = v; changed = true; }
  }
  if (!changed) return null;

  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort());
  pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort());

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  return { type: 'modify', path: 'package.json', previousContent };
}

async function updateEnvFiles(
  projectRoot: string,
  keys: Array<{ key: string; defaultValue: string; comment: string }>,
): Promise<FileOperation[]> {
  const ops: FileOperation[] = [];
  const examplePath = path.join(projectRoot, '.env.example');
  const envPath = path.join(projectRoot, '.env');

  const examplePrev = (await fs.pathExists(examplePath)) ? await fs.readFile(examplePath, 'utf-8') : null;
  const envPrev = (await fs.pathExists(envPath)) ? await fs.readFile(envPath, 'utf-8') : null;

  const manager = new EnvManager(projectRoot);
  for (const { key, defaultValue, comment } of keys) {
    await manager.addVariable(key, { defaultValue, comment, required: false });
  }

  const exampleNow = (await fs.pathExists(examplePath)) ? await fs.readFile(examplePath, 'utf-8') : null;
  const envNow = (await fs.pathExists(envPath)) ? await fs.readFile(envPath, 'utf-8') : null;

  if (exampleNow !== examplePrev) {
    ops.push({
      type: examplePrev === null ? 'create' : 'modify',
      path: '.env.example',
      ...(examplePrev !== null ? { previousContent: examplePrev } : {}),
    });
  }
  if (envNow !== envPrev) {
    ops.push({
      type: envPrev === null ? 'create' : 'modify',
      path: '.env',
      ...(envPrev !== null ? { previousContent: envPrev } : {}),
    });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// App-entry wiring
// ---------------------------------------------------------------------------

/**
 * Wire the generated observability primitives into the app entry.
 *
 *   Express: requestId() + httpLogger() before routes; healthRouter mounted;
 *            errorHandler() registered last (Express requires error handlers
 *            be installed *after* all other middleware/routes).
 *   Fastify: register requestId, httpLogger, healthRoutes, errorHandler
 *            plugins inside buildApp's body.
 *   Hono:    use(requestId()) + use(httpLogger()); route('/', healthRoutes);
 *            attachErrorHandler(app).
 *   NestJS:  AppModule.imports.push(ObservabilityModule).
 *   Next.js: no wiring — App Router file routes are auto-discovered.
 */
async function wireObservabilityIntoApp(
  projectRoot: string,
  config: PillarConfig,
): Promise<FileOperation | null> {
  const stack = config.project.stack;
  if (stack === 'nextjs') return null;
  if (stack === 'nestjs') return wireIntoNestModule(projectRoot, config);

  const appPath = path.join(projectRoot, 'src/app.ts');
  if (!(await fs.pathExists(appPath))) return null;

  const previousContent = await fs.readFile(appPath, 'utf-8');
  const importBase = importBasePath(config);
  let updated = previousContent;

  switch (stack) {
    case 'express':
      updated = ensureNamedImport(updated, `${importBase}/request-id.js`, 'bindRequestId');
      updated = ensureNamedImport(updated, `${importBase}/http-logger.js`, 'httpLogger');
      updated = ensureNamedImport(updated, `${importBase}/health.js`, 'healthRouter');
      updated = ensureNamedImport(updated, `${importBase}/error-handler.js`, 'errorHandler');
      // Insert middleware + routes + error handler at module scope, before the
      // export. Order matters for Express: error handler must come last.
      for (const stmt of [
        `app.use(bindRequestId());`,
        `app.use(httpLogger());`,
        `app.use(healthRouter);`,
        `app.use(errorHandler());`,
      ]) {
        if (!updated.includes(stmt)) {
          updated = addModuleStatement(updated, stmt, { beforeLastExport: true });
        }
      }
      break;

    case 'fastify': {
      updated = ensureNamedImport(updated, `${importBase}/request-id.js`, 'requestIdPlugin');
      updated = ensureNamedImport(updated, `${importBase}/http-logger.js`, 'httpLogger');
      updated = ensureNamedImport(updated, `${importBase}/health.js`, 'healthRoutes');
      updated = ensureNamedImport(updated, `${importBase}/error-handler.js`, 'errorHandler');
      // Splice plugin registrations just before the `return app`.
      const returnMatch = updated.match(/^\s*return\s+(?:app|fastify)\s*;?\s*$/m);
      if (returnMatch && returnMatch.index !== undefined) {
        const block = [
          `  await app.register(requestIdPlugin);`,
          `  await app.register(httpLogger);`,
          `  await app.register(healthRoutes);`,
          `  await app.register(errorHandler);`,
          '',
        ].join('\n');
        if (!updated.includes('await app.register(requestIdPlugin);')) {
          updated = updated.slice(0, returnMatch.index) + block + updated.slice(returnMatch.index);
        }
      }
      break;
    }

    case 'hono':
      updated = ensureNamedImport(updated, `${importBase}/request-id.js`, 'bindRequestId');
      updated = ensureNamedImport(updated, `${importBase}/http-logger.js`, 'httpLogger');
      updated = ensureNamedImport(updated, `${importBase}/health.js`, 'healthRoutes');
      updated = ensureNamedImport(updated, `${importBase}/error-handler.js`, 'attachErrorHandler');
      for (const stmt of [
        `app.use(bindRequestId());`,
        `app.use(httpLogger());`,
        `app.route('/', healthRoutes);`,
        `attachErrorHandler(app);`,
      ]) {
        if (!updated.includes(stmt)) {
          updated = addModuleStatement(updated, stmt, { beforeLastExport: true });
        }
      }
      break;

    default:
      return null;
  }

  if (updated === previousContent) return null;
  await fs.writeFile(appPath, updated, 'utf-8');
  return { type: 'modify', path: 'src/app.ts', previousContent };
}

async function wireIntoNestModule(
  projectRoot: string,
  config: PillarConfig,
): Promise<FileOperation | null> {
  const candidates = ['src/app.module.ts', 'src/app/app.module.ts'];
  let modulePath: string | null = null;
  for (const rel of candidates) {
    if (await fs.pathExists(path.join(projectRoot, rel))) { modulePath = rel; break; }
  }
  if (!modulePath) return null;

  const fullPath = path.join(projectRoot, modulePath);
  const previousContent = await fs.readFile(fullPath, 'utf-8');

  const importPath = path.relative(path.dirname(modulePath), observabilityModulePathAbs(config)).replace(/\\/g, '/');
  const normalized = (importPath.startsWith('.') ? importPath : './' + importPath).replace(/\.ts$/, '.js');

  let updated = ensureNamedImport(previousContent, normalized, 'ObservabilityModule');
  const withImports = addElementToDecoratorArray(updated, 'Module', 'imports', 'ObservabilityModule');
  if (withImports !== null) updated = withImports;

  if (updated === previousContent) return null;

  await fs.writeFile(fullPath, updated, 'utf-8');
  return { type: 'modify', path: modulePath, previousContent };
}

/** Relative specifier (without trailing /file.js) resolving from `src/app.ts`. */
function importBasePath(config: PillarConfig): string {
  const arch = config.project.architecture;
  switch (arch) {
    case 'feature-first': return './features/observability';
    case 'modular':       return './modules/observability';
    case 'layered':       return './observability';
  }
}

function observabilityModulePathAbs(config: PillarConfig): string {
  const arch = config.project.architecture;
  const base = arch === 'feature-first'
    ? 'src/features/observability'
    : arch === 'modular'
      ? 'src/modules/observability'
      : 'src/observability';
  return `${base}/observability.module.ts`;
}
