import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, type PillarConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { ResourceGenerator } from '../core/generator/resource-generator.js';
import { PluginRegistry, PluginLoadError } from '../core/plugins/index.js';
import { generateSkeleton } from '../core/generator/skeleton.js';
import type { ResourceField } from '../core/generator/types.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';
import { resolveResourcePath, resolveResourceFilePath } from '../utils/resolve-resource-path.js';
import { toPascalCase, toCamelCase, pluralizeResource } from '../utils/naming.js';
import { addElementToDecoratorArray, addModuleStatement, ensureNamedImport } from '../core/ast/index.js';
import { EnvManager } from '../core/env/index.js';
import { PlanBuilder, PlanExecutor } from '../core/plan/index.js';
import type { Plan } from '../core/plan/index.js';
import { isPreview, printPlan, type PreviewFlags } from './_preview.js';
import {
  MiddlewareGenerator,
  SUPPORTED_MIDDLEWARE_KINDS,
  type MiddlewareKind,
  type MiddlewareWiring,
} from '../core/middleware/index.js';

interface AddResourceOptions extends PreviewFlags {
  fields?: string;
  noTest?: boolean;
  only?: string;
  force?: boolean;
}

/**
 * Pure computation of the route-wiring transform for an app entry file.
 * Returns `null` when there is nothing to wire (stack is Next.js, entry
 * file missing, or the routes are already registered).
 */
interface PlannedWiring {
  relativePath: string;
  previousContent: string;
  newContent: string;
}

export async function addResourceCommand(name: string, options: AddResourceOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error(
      'Not inside a Pillar project.',
      'Run "pillar init" first to create a new project.',
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const resourceName = name.toLowerCase();

  // Parse fields
  const fields = options.fields ? parseFields(options.fields) : undefined;

  // Parse --only filter
  const only = options.only ? options.only.split(',').map((s) => s.trim()) : undefined;

  const generator = new ResourceGenerator(config);
  let files = generator.generate({
    name: resourceName,
    fields,
    skipTest: options.noTest,
    only,
  });

  // Plugins may contribute additional files and transform existing ones
  // before anything touches the filesystem. Registry load errors are
  // warnings, never fatal — a broken plugin must not block core codegen.
  const registry = PluginRegistry.fromConfig(projectRoot, config);
  try {
    await registry.load();
  } catch (err) {
    if (err instanceof PluginLoadError) {
      logger.info(`Plugin warning: ${err.message}`);
    } else {
      throw err;
    }
  }

  const pluginExtras = await registry.runOnResourceGenerated({
    resourceName,
    generatedFiles: files,
  });
  files = [...files, ...pluginExtras];

  const transformed: typeof files = [];
  for (const f of files) {
    transformed.push(await registry.runTransformGeneratedFile(f));
  }
  files = transformed;

  // Build a single Plan covering generated files + route wiring. The
  // preview and execute paths share this plan, so a `--preview` diff is
  // a byte-exact preview of what a real run will write.
  const command = `add resource ${resourceName}`;
  const builder = new PlanBuilder(projectRoot, command);

  for (const file of files) {
    if (options.force) {
      // Force: blow past any existing file. PlanBuilder.create promotes
      // to modify when the target exists, so force here means "don't
      // bail on conflicts"; the plan still renders an accurate diff.
      await builder.create(file.relativePath, file.content, file.purpose);
    } else {
      const exists = await fs.pathExists(path.join(projectRoot, file.relativePath));
      if (exists && !isPreview(options)) {
        // Defer conflict reporting to a unified block below so we can
        // show every conflict at once. Skip adding to the plan for now.
        continue;
      }
      await builder.create(file.relativePath, file.content, file.purpose);
    }
  }

  // Route-wiring change is computed against *the current* app entry. In
  // a preview, generated route files don't yet exist on disk, but that
  // doesn't affect the wiring transform — it only reads the entry file.
  const wiring = await planRouteWiring(projectRoot, config, resourceName);
  if (wiring) {
    await builder.modify(wiring.relativePath, wiring.newContent, `wire ${resourceName} routes`);
  }

  const plan = builder.build();

  if (isPreview(options)) {
    printPlan(plan);
    return;
  }

  // Non-preview path: reject up-front on conflicts unless --force was given.
  if (!options.force) {
    const conflicts: string[] = [];
    for (const file of files) {
      if (await fs.pathExists(path.join(projectRoot, file.relativePath))) {
        conflicts.push(file.relativePath);
      }
    }
    if (conflicts.length > 0) {
      logger.error('Files already exist:');
      logger.list(conflicts);
      logger.blank();
      logger.info('Use --force to overwrite, or --preview to inspect the diff first.');
      process.exitCode = 1;
      return;
    }
  }

  const { operations } = await withSpinner(
    `Generating ${resourceName} resource (${plan.changes.length} change${plan.changes.length === 1 ? '' : 's'})`,
    async () => new PlanExecutor(projectRoot).execute(plan),
  );

  // Register new files in the project map (the map is tangential to the
  // code-generation plan and is updated separately; map history is kept
  // out of FileOperation because map.json already versions itself).
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    for (const file of files) {
      await mapManager.registerEntry(file.relativePath, file.purpose);
    }
    logger.info('Project map updated');
  }

  await new HistoryManager(projectRoot).record(command, operations);

  logger.blank();
  logger.success(`Resource "${resourceName}" generated successfully`);
  logger.blank();
  logger.info('Files created:');
  logger.list(files.map((f) => f.relativePath));
  logger.blank();
}

interface AddMiddlewareOptions {
  purpose?: string;
  dryRun?: boolean;
  force?: boolean;
  /** Emit files only — skip package.json / .env / app-entry wiring. */
  filesOnly?: boolean;
}

/**
 * `pillar add middleware <kind>` — two shapes share this command:
 *
 *   1. **Known production kinds** (`cors`, `rate-limit`, `helmet`, `request-id`):
 *      emits a stack-aware template, adds deps to package.json, adds env keys,
 *      and splices the registration statement into the app entry via AST.
 *      History-backed — `pillar undo` reverses the whole scaffold in one step.
 *
 *   2. **Arbitrary names** (anything else): falls back to a generic skeleton
 *      stub at the right architectural location. Backwards-compatible with
 *      prior behavior.
 */
export async function addMiddlewareCommand(name: string, options: AddMiddlewareOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const middlewareName = name.toLowerCase();

  if (SUPPORTED_MIDDLEWARE_KINDS.includes(middlewareName as MiddlewareKind)) {
    await addProductionMiddleware(projectRoot, config, middlewareName as MiddlewareKind, options);
    return;
  }

  if (config.generation.purposeRequired && !options.purpose) {
    logger.error(
      'A --purpose is required by this project configuration.',
      'Re-run with -p "<why this middleware exists>" or set generation.purposeRequired=false.',
    );
    process.exitCode = 1;
    return;
  }

  const ext = config.project.language === 'typescript' ? 'ts' : 'js';

  const basePath = config.project.architecture === 'layered'
    ? 'src/middleware'
    : `${resolveResourcePath(config.project.architecture, 'shared')}/middleware`;

  const fileName = `${middlewareName}.middleware.${ext}`;
  const relativePath = `${basePath}/${fileName}`;
  const purpose = options.purpose ?? `${middlewareName} middleware`;

  const content = generateSkeleton(fileName, purpose, {
    stack: config.project.stack,
    language: config.project.language,
  });

  if (options.dryRun) {
    logger.banner('Dry Run — Middleware Generation');
    logger.info(`Middleware: ${chalk.cyan(middlewareName)}`);
    logger.info(`File: ${chalk.cyan(relativePath)}`);
    logger.blank();
    logger.info('Preview:');
    logger.blank();
    console.log(chalk.dim(content));
    return;
  }

  const fullPath = path.join(projectRoot, relativePath);

  if (!options.force && await fs.pathExists(fullPath)) {
    logger.error(`File already exists: ${relativePath}`);
    logger.info('Use --force to overwrite.');
    process.exitCode = 1;
    return;
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Generating ${middlewareName} middleware`, async () => {
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    operations.push({ type: 'create', path: relativePath });
  });

  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    await mapManager.registerEntry(relativePath, purpose);
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`add middleware ${middlewareName}`, operations);

  logger.blank();
  logger.success(`Middleware "${middlewareName}" generated`);
  logger.table([
    ['File', relativePath],
    ['Purpose', purpose],
  ]);
  logger.blank();
}

/**
 * Pure computation of the route-wiring transform for an app entry file.
 *
 * Decides which entry file applies (Express/Hono/Fastify: `src/app.ts`,
 * NestJS: `src/app.module.ts`, Next.js: no-op), computes the new content,
 * and returns both old and new. Callers may apply the change via
 * PlanBuilder/PlanExecutor or render it as part of a preview.
 *
 * Returns `null` when there is no wiring work to do (stack has no
 * central router, entry file missing, or the registration is already
 * present and idempotent).
 */
async function planRouteWiring(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
): Promise<PlannedWiring | null> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const stack = config.project.stack;

  if (stack === 'nextjs') return null;
  if (stack === 'nestjs') {
    return planNestAppModuleWiring(projectRoot, config, resourceName, ext);
  }

  const appRel = `src/app.${ext}`;
  const appPath = path.join(projectRoot, appRel);
  if (!(await fs.pathExists(appPath))) return null;

  const content = await fs.readFile(appPath, 'utf-8');
  const previousContent = content;

  const camelName = toCamelCase(resourceName);
  const pluralPath = pluralizeResource(camelName);
  // `resourceName` originates from a CLI argument, so `camelName` must be
  // escaped before it is spliced into a RegExp constructor. Without this,
  // a crafted name could alter the pattern (CodeQL js/regex-injection).
  const camelNameRe = escapeRegExp(camelName);

  const routesFilePath = resolveResourceFilePath(config.project.architecture, resourceName, 'routes', ext);
  const routesRelPath = `./${path.relative('src', routesFilePath).replace(/\.ts$/, '.js')}`;

  let importLine: string;
  let registrationLine: string;
  let registrationPattern: RegExp;

  switch (stack) {
    case 'fastify':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `  app.register(${camelName}Routes);`;
      registrationPattern = new RegExp(`app\\.register\\(\\s*${camelNameRe}Routes\\s*\\)`);
      break;
    case 'hono':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `app.route('/${pluralPath}', ${camelName}Routes);`;
      registrationPattern = new RegExp(`app\\.route\\([^)]*${camelNameRe}Routes`);
      break;
    default:
      importLine = `import { ${camelName}Router } from '${routesRelPath}';`;
      registrationLine = `app.use('/${pluralPath}', ${camelName}Router);`;
      registrationPattern = new RegExp(`app\\.use\\([^)]*${camelNameRe}Router`);
      break;
  }

  // Skip if both pieces are already present
  if (content.includes(importLine) && registrationPattern.test(content)) return null;

  let updated = content;

  if (!content.includes(importLine)) {
    updated = insertImport(updated, importLine);
  }

  if (!registrationPattern.test(updated)) {
    updated = insertRegistration(updated, registrationLine, stack);
  }

  if (updated === previousContent) return null;

  return { relativePath: appRel, previousContent, newContent: updated };
}

function toImportPath(relPath: string): string {
  let p = relPath.replace(/\\/g, '/').replace(/\.tsx?$/, '.js');
  if (!p.startsWith('.')) p = './' + p;
  return p;
}

function insertImport(content: string, importLine: string): string {
  const lines = content.split('\n');
  let lastImportIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('import ')) lastImportIndex = i;
  }
  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importLine);
  } else {
    lines.unshift(importLine);
  }
  return lines.join('\n');
}

/**
 * Insert a route-registration line. Strategy, in priority order:
 *   1. Replace an explicit `// TODO: register …` comment if present.
 *   2. For Fastify, insert before the closing `}` of the `buildApp`/async
 *      factory function (registrations must live inside the function body).
 *   3. Insert before the first `app.listen(` call.
 *   4. Insert before the first `export ` statement.
 *   5. Append to end of file.
 *
 * The previous implementation depended on either the TODO or a trailing
 * export being present; if users deleted the TODO and there was no export
 * (e.g., Fastify factory files), registrations were silently dropped.
 */
function insertRegistration(content: string, registrationLine: string, stack: string): string {
  const todoMatch = content.match(/^[ \t]*\/\/\s*TODO:?\s*register.*$/m);
  if (todoMatch && todoMatch.index !== undefined) {
    return content.replace(todoMatch[0], registrationLine.replace(/^\s+/, ''));
  }

  if (stack === 'fastify') {
    // Insert before the last `}` that closes the async factory function.
    // Heuristic: find `return app;` or `return fastify` and inject before it.
    const returnMatch = content.match(/^\s*return\s+(?:app|fastify)\s*;?\s*$/m);
    if (returnMatch && returnMatch.index !== undefined) {
      return content.slice(0, returnMatch.index) + registrationLine + '\n' + content.slice(returnMatch.index);
    }
  }

  const listenMatch = content.match(/^[ \t]*(?:await\s+)?(?:app|server)\.listen\s*\(/m);
  if (listenMatch && listenMatch.index !== undefined) {
    return content.slice(0, listenMatch.index) + registrationLine + '\n' + content.slice(listenMatch.index);
  }

  const exportMatch = content.match(/\nexport\s/);
  if (exportMatch && exportMatch.index !== undefined) {
    return content.slice(0, exportMatch.index) + `\n${registrationLine}\n` + content.slice(exportMatch.index);
  }

  return content.trimEnd() + '\n\n' + registrationLine + '\n';
}

/**
 * NestJS auto-wires controllers/providers through the `AppModule`'s
 * `@Module({ controllers, providers })` decorator. We locate the module
 * file, add imports for the new controller/service, and extend those
 * arrays. If we can't find a safe spot we return `null` rather than
 * corrupting the module.
 */
async function planNestAppModuleWiring(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  ext: string,
): Promise<PlannedWiring | null> {
  const candidates = [
    `src/app.module.${ext}`,
    `src/app/app.module.${ext}`,
  ];
  let modulePath: string | null = null;
  for (const rel of candidates) {
    if (await fs.pathExists(path.join(projectRoot, rel))) {
      modulePath = rel;
      break;
    }
  }
  if (!modulePath) return null;

  const fullPath = path.join(projectRoot, modulePath);
  const content = await fs.readFile(fullPath, 'utf-8');
  const previousContent = content;

  const pascalName = toPascalCase(resourceName);
  const controllerClass = `${pascalName}Controller`;
  const serviceClass = `${pascalName}Service`;

  const arch = config.project.architecture;
  const controllerAbs = resolveResourceFilePath(arch, resourceName, 'controller', ext);
  const serviceAbs = resolveResourceFilePath(arch, resourceName, 'service', ext);
  const moduleDir = path.dirname(modulePath);
  const controllerFile = toImportPath(path.relative(moduleDir, controllerAbs));
  const serviceFile = toImportPath(path.relative(moduleDir, serviceAbs));

  // AST path keeps the AppModule formatted correctly (Prettier-friendly)
  // and handles the "property doesn't exist yet" case cleanly. We only use
  // text-splice fallbacks for imports to preserve behaviour when ts-morph
  // can't parse the file (e.g., mid-edit).
  let updated = content;
  updated = ensureNamedImport(updated, controllerFile, controllerClass);
  updated = ensureNamedImport(updated, serviceFile, serviceClass);

  const withControllers = addElementToDecoratorArray(updated, 'Module', 'controllers', controllerClass);
  if (withControllers !== null) updated = withControllers;
  const withProviders = addElementToDecoratorArray(updated, 'Module', 'providers', serviceClass);
  if (withProviders !== null) updated = withProviders;

  if (updated === previousContent) return null;

  return { relativePath: modulePath, previousContent, newContent: updated };
}


/**
 * Escape RegExp metacharacters so a user-controlled string can be used
 * safely inside `new RegExp(...)`.
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Production-grade middleware scaffold for known kinds (cors, rate-limit,
 * helmet, request-id). Full pipeline: emit file → add deps → add env keys →
 * splice wiring into app.ts / main.ts via AST → record history.
 */
async function addProductionMiddleware(
  projectRoot: string,
  config: PillarConfig,
  kind: MiddlewareKind,
  options: { dryRun?: boolean; force?: boolean; filesOnly?: boolean },
): Promise<void> {
  let generated;
  try {
    generated = new MiddlewareGenerator(config, kind).generate();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  const { files, dependencies, devDependencies, envKeys, wiring, importBinding, importFrom } = generated;

  if (options.dryRun) {
    logger.banner(`Dry Run — Middleware (${kind})`);
    logger.info(`Stack: ${chalk.cyan(config.project.stack)}`);
    logger.blank();
    logger.info(`Files (${files.length}):`);
    for (const f of files) {
      const exists = await fs.pathExists(path.join(projectRoot, f.relativePath));
      const tag = exists ? chalk.yellow('(exists)') : chalk.green('(new)');
      console.log(`  ${chalk.dim('→')} ${f.relativePath} ${tag}`);
      console.log(`    ${chalk.dim(f.purpose)}`);
    }
    const depEntries = [
      ...Object.entries(dependencies).map(([k, v]) => `${k}@${v}`),
      ...Object.entries(devDependencies).map(([k, v]) => `${k}@${v} (dev)`),
    ];
    if (depEntries.length > 0) {
      logger.blank();
      logger.info('Dependencies to add:');
      logger.list(depEntries);
    }
    if (envKeys.length > 0) {
      logger.blank();
      logger.info('Env keys to add:');
      logger.list(envKeys.map((e) => `${e.key} — ${e.comment}`));
    }
    if (wiring) {
      logger.blank();
      logger.info(`Will wire into ${wiringTargetLabel(wiring.target)}: ${chalk.cyan(wiring.statement.trim())}`);
    } else {
      logger.blank();
      logger.info('No auto-wiring for this stack — the file is emitted as a helper for manual integration.');
    }
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

  await withSpinner(`Scaffolding ${kind} middleware (${files.length} file${files.length === 1 ? '' : 's'})`, async () => {
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
    const pkgOp = await updateMiddlewarePackageJson(projectRoot, dependencies, devDependencies);
    if (pkgOp) operations.push(pkgOp);

    if (envKeys.length > 0) {
      const envOps = await updateMiddlewareEnvFiles(projectRoot, envKeys);
      operations.push(...envOps);
    }

    if (wiring && importBinding && importFrom) {
      const wireOp = await wireMiddlewareIntoApp(projectRoot, config, wiring, importBinding, importFrom);
      if (wireOp) operations.push(wireOp);
    }
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`add middleware ${kind}`, operations);

  logger.blank();
  logger.success(`Middleware (${kind}) scaffold generated`);
  logger.blank();
  logger.info('Files created:');
  logger.list(files.map((f) => f.relativePath));

  const nextSteps: string[] = [];
  if (Object.keys(dependencies).length + Object.keys(devDependencies).length > 0) {
    nextSteps.push(`Install deps: ${chalk.cyan('npm install')}`);
  }
  if (envKeys.length > 0) {
    nextSteps.push(`Review env values in ${chalk.cyan('.env')}`);
  }
  if (!wiring) {
    nextSteps.push(`Integrate manually — this stack has no auto-wiring.`);
  }
  if (nextSteps.length > 0) {
    logger.blank();
    logger.info('Next steps:');
    logger.list(nextSteps);
  }
  logger.blank();
}

function wiringTargetLabel(target: MiddlewareWiring['target']): string {
  switch (target) {
    case 'app-module-scope':     return 'src/app.ts (module scope)';
    case 'fastify-factory-body': return 'src/app.ts (inside the factory)';
    case 'nest-bootstrap-body':  return 'src/main.ts (inside bootstrap)';
  }
}

/**
 * Add middleware deps to package.json without downgrading pinned versions.
 * Mirrors the policy used by `addAuthCommand`.
 */
async function updateMiddlewarePackageJson(
  projectRoot: string,
  deps: Record<string, string>,
  devDeps: Record<string, string>,
): Promise<FileOperation | null> {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!(await fs.pathExists(pkgPath))) return null;
  if (Object.keys(deps).length === 0 && Object.keys(devDeps).length === 0) return null;

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

async function updateMiddlewareEnvFiles(
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

/**
 * Splice the middleware import + registration into the app entry file.
 *
 *   - Express / Hono : module-scope, just before the last export.
 *   - Fastify        : inside the factory body, just before `return app;`.
 *   - NestJS         : inside `bootstrap`, just before `await app.listen(...)`.
 *
 * All three paths are idempotent — running the command twice is a no-op.
 */
async function wireMiddlewareIntoApp(
  projectRoot: string,
  config: PillarConfig,
  wiring: MiddlewareWiring,
  importBinding: string,
  importFrom: string,
): Promise<FileOperation | null> {
  const stack = config.project.stack;
  const entryRel = stack === 'nestjs' ? 'src/main.ts' : 'src/app.ts';
  const entryAbs = path.join(projectRoot, entryRel);
  if (!(await fs.pathExists(entryAbs))) return null;

  const previousContent = await fs.readFile(entryAbs, 'utf-8');
  let updated = ensureNamedImport(previousContent, importFrom, importBinding);

  switch (wiring.target) {
    case 'app-module-scope':
      if (!containsStatement(updated, wiring.statement)) {
        updated = addModuleStatement(updated, wiring.statement, { beforeLastExport: true });
      }
      break;

    case 'fastify-factory-body': {
      if (!containsStatement(updated, wiring.statement)) {
        const returnMatch = updated.match(/^\s*return\s+(?:app|fastify)\s*;?\s*$/m);
        if (returnMatch && returnMatch.index !== undefined) {
          updated = updated.slice(0, returnMatch.index) + wiring.statement + '\n' + updated.slice(returnMatch.index);
        } else {
          // Fallback: append at module scope (user's factory shape is non-standard).
          updated = addModuleStatement(updated, wiring.statement);
        }
      }
      break;
    }

    case 'nest-bootstrap-body': {
      if (!containsStatement(updated, wiring.statement)) {
        const listenMatch = updated.match(/^[ \t]*(?:await\s+)?app\.listen\s*\(/m);
        if (listenMatch && listenMatch.index !== undefined) {
          const indent = (listenMatch[0].match(/^[ \t]*/) ?? [''])[0];
          updated = updated.slice(0, listenMatch.index) + indent + wiring.statement + '\n' + updated.slice(listenMatch.index);
        } else {
          updated = addModuleStatement(updated, wiring.statement);
        }
      }
      break;
    }
  }

  if (updated === previousContent) return null;

  await fs.writeFile(entryAbs, updated, 'utf-8');
  return { type: 'modify', path: entryRel, previousContent };
}

/** Cheap "already wired?" check — compares trimmed source line presence. */
function containsStatement(source: string, statement: string): boolean {
  const trimmed = statement.trim();
  if (trimmed.length === 0) return true;
  return source.includes(trimmed);
}

/**
 * Parse field string like "name:string email:string age:number"
 */
function parseFields(fieldsStr: string): ResourceField[] {
  return fieldsStr.split(/\s+/).map((field) => {
    const parts = field.split(':');
    const name = parts[0] ?? field;
    const type = parts[1] ?? 'string';
    const modifiers = parts.slice(2);

    return {
      name,
      type,
      required: !modifiers.includes('optional'),
      unique: modifiers.includes('unique'),
    };
  });
}
