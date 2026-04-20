import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, type PillarConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { AuthGenerator, type AuthStrategy } from '../core/auth/index.js';
import { EnvManager } from '../core/env/index.js';
import { addElementToDecoratorArray, addModuleStatement, ensureNamedImport } from '../core/ast/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface AddAuthOptions {
  strategy?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Skip package.json / env / app wiring — emit files only. */
  filesOnly?: boolean;
}

const SUPPORTED_STRATEGIES: readonly AuthStrategy[] = ['jwt'] as const;

/**
 * `pillar add auth --strategy jwt` — scaffold a complete auth module.
 *
 * Scope:
 *   - Emits all auth files (service, controller, routes/guard, middleware,
 *     repository, validator, types, jwt util) tailored to the project's
 *     stack + architecture.
 *   - Adds `jsonwebtoken` + `bcryptjs` (and their @types/*) to package.json.
 *   - Adds `JWT_SECRET` + `JWT_EXPIRES_IN` to .env.example and .env.
 *   - Wires the auth router into app.ts (Express/Fastify/Hono) or
 *     AuthModule into AppModule (NestJS). Next.js needs no wiring — the
 *     generated App Router handlers are auto-discovered.
 *   - Records every mutation in history so `pillar undo` reverses the
 *     entire scaffold in one step.
 */
export async function addAuthCommand(options: AddAuthOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const strategy = (options.strategy ?? 'jwt') as AuthStrategy;
  if (!SUPPORTED_STRATEGIES.includes(strategy)) {
    logger.error(
      `Unknown auth strategy: "${strategy}".`,
      `Supported: ${SUPPORTED_STRATEGIES.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  let generated;
  try {
    generated = new AuthGenerator(config, strategy).generate();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { files, dependencies, devDependencies, envKeys } = generated;

  if (options.dryRun) {
    logger.banner('Dry Run — Auth Scaffold');
    logger.info(`Strategy: ${chalk.cyan(strategy)}`);
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

  // Conflict detection (unless --force).
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

  await withSpinner(`Scaffolding auth (${files.length} files)`, async () => {
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

    const wireOp = await wireAuthIntoApp(projectRoot, config);
    if (wireOp) operations.push(wireOp);
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`add auth (${strategy})`, operations);

  logger.blank();
  logger.success(`Auth (${strategy}) scaffold generated`);
  logger.blank();
  logger.info('Files created:');
  logger.list(files.map((f) => f.relativePath));
  logger.blank();
  logger.info('Next steps:');
  logger.list([
    `Install deps: ${chalk.cyan('npm install')}`,
    `Set a strong JWT_SECRET in ${chalk.cyan('.env')} (min 16 chars)`,
    'Replace the in-memory AuthRepository with your real DB layer',
    'Protect routes with the generated authenticate middleware / AuthGuard',
  ]);
  logger.blank();
}

/**
 * Add jsonwebtoken/bcryptjs + types to package.json if absent.
 * Preserves existing ranges — never downgrades user-pinned versions.
 */
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

  // Sort keys for deterministic diffs.
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort());
  pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort());

  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  return { type: 'modify', path: 'package.json', previousContent };
}

/**
 * Add env keys to .env.example (and .env if present).
 * EnvManager.addVariable is idempotent per-file.
 */
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
    await manager.addVariable(key, { defaultValue, comment, required: true });
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

/**
 * Wire the generated auth router into the app entry.
 *
 *   - Express: `import { authRouter } from …; app.use('/auth', authRouter);`
 *   - Fastify: `import { authRoutes } from …; app.register(authRoutes);`
 *   - Hono:    `import { authRoutes } from …; app.route('/auth', authRoutes);`
 *   - NestJS:  extend AppModule's `imports: [AuthModule]`.
 *   - Next.js: no wiring needed (file-based routing).
 */
async function wireAuthIntoApp(
  projectRoot: string,
  config: PillarConfig,
): Promise<FileOperation | null> {
  const stack = config.project.stack;
  if (stack === 'nextjs') return null;
  if (stack === 'nestjs') return wireAuthIntoNestModule(projectRoot, config);

  const appPath = path.join(projectRoot, 'src/app.ts');
  if (!(await fs.pathExists(appPath))) return null;

  const previousContent = await fs.readFile(appPath, 'utf-8');
  const importPath = authImportPath(config);

  let updated = previousContent;
  let importBinding: string;
  let registration: string;

  switch (stack) {
    case 'express':
      importBinding = 'authRouter';
      registration = `app.use('/auth', authRouter);`;
      break;
    case 'fastify':
      importBinding = 'authRoutes';
      registration = `  app.register(authRoutes);`;
      break;
    case 'hono':
      importBinding = 'authRoutes';
      registration = `app.route('/auth', authRoutes);`;
      break;
    default:
      return null;
  }

  updated = ensureNamedImport(updated, importPath, importBinding);

  if (stack === 'fastify') {
    // Fastify's app factory is an exported function — the registration
    // statement lives inside its body, not at module scope. The endpoint
    // extension's AST helpers cover this shape; reuse the pattern here
    // via a direct `return app` splice (resilient to either factory style).
    const returnMatch = updated.match(/^\s*return\s+(?:app|fastify)\s*;?\s*$/m);
    if (returnMatch && returnMatch.index !== undefined) {
      if (!updated.includes(registration.trim())) {
        updated = updated.slice(0, returnMatch.index) + registration + '\n' + updated.slice(returnMatch.index);
      }
    }
  } else {
    updated = addModuleStatement(updated, registration, { beforeLastExport: true });
  }

  if (updated === previousContent) return null;

  await fs.writeFile(appPath, updated, 'utf-8');
  return { type: 'modify', path: 'src/app.ts', previousContent };
}

async function wireAuthIntoNestModule(
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

  const importPath = path.relative(path.dirname(modulePath), authImportPathAbs(config)).replace(/\\/g, '/');
  const normalized = (importPath.startsWith('.') ? importPath : './' + importPath).replace(/\.ts$/, '.js');

  let updated = ensureNamedImport(previousContent, normalized, 'AuthModule');
  const withImports = addElementToDecoratorArray(updated, 'Module', 'imports', 'AuthModule');
  if (withImports !== null) updated = withImports;

  if (updated === previousContent) return null;

  await fs.writeFile(fullPath, updated, 'utf-8');
  return { type: 'modify', path: modulePath, previousContent };
}

/** Relative specifier (with .js) that resolves from `src/app.ts` to the auth routes. */
function authImportPath(config: PillarConfig): string {
  const arch = config.project.architecture;
  const base = arch === 'feature-first'
    ? './features/auth'
    : arch === 'modular'
      ? './modules/auth'
      : './auth';
  const file = config.project.stack === 'express' ? 'auth.routes.js' : 'auth.routes.js';
  return `${base}/${file}`;
}

/** Absolute (project-root-relative) path to the NestJS AuthModule file. */
function authImportPathAbs(config: PillarConfig): string {
  const arch = config.project.architecture;
  const base = arch === 'feature-first'
    ? 'src/features/auth'
    : arch === 'modular'
      ? 'src/modules/auth'
      : 'src/auth';
  return `${base}/auth.module.ts`;
}
