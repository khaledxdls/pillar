import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, type PillarConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { ResourceGenerator } from '../core/generator/resource-generator.js';
import { generateSkeleton } from '../core/generator/skeleton.js';
import type { ResourceField } from '../core/generator/types.js';
import { logger, findProjectRoot, withSpinner, resolveResourcePath } from '../utils/index.js';

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
  const files = generator.generate({
    name: resourceName,
    fields,
    skipTest: options.noTest,
    only,
  });

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

  // NestJS and Next.js handle routing differently
  if (stack === 'nestjs' || stack === 'nextjs') return null;

  const appPath = path.join(projectRoot, `src/app.${ext}`);
  if (!(await fs.pathExists(appPath))) return null;

  const content = await fs.readFile(appPath, 'utf-8');
  const previousContent = content;

  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);
  const camelName = resourceName.charAt(0).toLowerCase() + resourceName.slice(1);
  const basePath = resolveResourcePath(config.project.architecture, resourceName);

  // Compute relative import path from src/app.ts to the routes file
  const routesRelPath = `./${path.relative('src', basePath)}/${resourceName}.routes.js`;

  let importLine: string;
  let registrationLine: string;

  switch (stack) {
    case 'fastify':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `app.register(${camelName}Routes);`;
      break;
    case 'hono':
      importLine = `import { ${camelName}Routes } from '${routesRelPath}';`;
      registrationLine = `app.route('/${camelName}s', ${camelName}Routes);`;
      break;
    default:
      // Express
      importLine = `import { ${camelName}Router } from '${routesRelPath}';`;
      registrationLine = `app.use('/${camelName}s', ${camelName}Router);`;
      break;
  }

  // Skip if already wired
  if (content.includes(importLine) || content.includes(registrationLine)) return null;

  let updated = content;

  // Add import after the last existing import
  const lines = updated.split('\n');
  let lastImportIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('import ')) {
      lastImportIndex = i;
    }
  }
  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importLine);
  } else {
    lines.unshift(importLine);
  }
  updated = lines.join('\n');

  // Add registration before the TODO comment or export
  const todoMatch = updated.match(/^[ \t]*\/\/\s*TODO:?\s*register.*$/m);
  if (todoMatch && todoMatch.index !== undefined) {
    // Replace the TODO comment with the registration line
    updated = updated.replace(todoMatch[0], `${registrationLine}`);
  } else {
    // Insert before export
    const exportMatch = updated.match(/\nexport\s/);
    if (exportMatch && exportMatch.index !== undefined) {
      updated = updated.slice(0, exportMatch.index) + `\n${registrationLine}\n` + updated.slice(exportMatch.index);
    }
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
