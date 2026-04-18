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
import { addElementToDecoratorArray, ensureNamedImport } from '../core/ast/index.js';

interface AddResourceOptions {
  fields?: string;
  noTest?: boolean;
  only?: string;
  dryRun?: boolean;
  force?: boolean;
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

  if (options.dryRun) {
    logger.banner('Dry Run — Resource Generation');
    logger.info(`Resource: ${chalk.cyan(resourceName)}`);
    logger.info(`Architecture: ${chalk.cyan(config.project.architecture)}`);
    logger.info(`Files to generate: ${chalk.cyan(String(files.length))}`);
    logger.blank();

    for (const file of files) {
      const exists = await fs.pathExists(path.join(projectRoot, file.relativePath));
      const status = exists ? chalk.yellow('(exists)') : chalk.green('(new)');
      console.log(`  ${chalk.dim('→')} ${file.relativePath} ${status}`);
      console.log(`    ${chalk.dim(file.purpose)}`);
    }
    return;
  }

  // Check for conflicts
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
      logger.info('Use --force to overwrite, or --dry-run to preview.');
      process.exitCode = 1;
      return;
    }
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Generating ${resourceName} resource (${files.length} files)`, async () => {
    for (const file of files) {
      const fullPath = path.join(projectRoot, file.relativePath);
      const exists = await fs.pathExists(fullPath);

      let previousContent: string | undefined;
      if (exists) {
        previousContent = await fs.readFile(fullPath, 'utf-8');
      }

      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, file.content, 'utf-8');

      operations.push({
        type: exists ? 'modify' : 'create',
        path: file.relativePath,
        ...(previousContent !== undefined ? { previousContent } : {}),
      });
    }
  });

  // Register all files in the map
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    for (const file of files) {
      await mapManager.registerEntry(file.relativePath, file.purpose);
    }
    logger.info('Project map updated');
  }

  // Auto-wire routes into app.ts
  const routeWireResult = await wireRouteIntoApp(projectRoot, config, resourceName);
  if (routeWireResult) {
    operations.push(routeWireResult.operation);
  }

  // Record history
  const historyManager = new HistoryManager(projectRoot);
  await historyManager.record(`add resource ${resourceName}`, operations);

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
}

export async function addMiddlewareCommand(name: string, options: AddMiddlewareOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const middlewareName = name.toLowerCase();
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
 * Wire a resource's routes into the app entry file (app.ts/app.js).
 * Adds the import statement and app.use() registration.
 */
async function wireRouteIntoApp(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
): Promise<{ operation: FileOperation } | null> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const stack = config.project.stack;

  if (stack === 'nextjs') return null;
  if (stack === 'nestjs') {
    return wireIntoNestAppModule(projectRoot, config, resourceName, ext);
  }

  const appPath = path.join(projectRoot, `src/app.${ext}`);
  if (!(await fs.pathExists(appPath))) return null;

  const content = await fs.readFile(appPath, 'utf-8');
  const previousContent = content;

  const camelName = toCamelCase(resourceName);
  const pluralPath = pluralizeResource(camelName);

  const routesFilePath = resolveResourceFilePath(config.project.architecture, resourceName, 'routes', ext);
  const routesRelPath = `./${path.relative('src', routesFilePath).replace(/\.ts$/, '.js')}`;

  let importLine: string;
  let registrationLine: string;
  let registrationPattern: RegExp;

  switch (stack) {
    case 'fastify':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `  app.register(${camelName}Routes);`;
      registrationPattern = new RegExp(`app\\.register\\(\\s*${camelName}Routes\\s*\\)`);
      break;
    case 'hono':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `app.route('/${pluralPath}', ${camelName}Routes);`;
      registrationPattern = new RegExp(`app\\.route\\([^)]*${camelName}Routes`);
      break;
    default:
      importLine = `import { ${camelName}Router } from '${routesRelPath}';`;
      registrationLine = `app.use('/${pluralPath}', ${camelName}Router);`;
      registrationPattern = new RegExp(`app\\.use\\([^)]*${camelName}Router`);
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

  await fs.writeFile(appPath, updated, 'utf-8');
  return {
    operation: {
      type: 'modify',
      path: `src/app.${ext}`,
      previousContent,
    },
  };
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
async function wireIntoNestAppModule(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  ext: string,
): Promise<{ operation: FileOperation } | null> {
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

  await fs.writeFile(fullPath, updated, 'utf-8');
  return {
    operation: { type: 'modify', path: modulePath, previousContent },
  };
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
