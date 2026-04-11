import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { ResourceGenerator } from '../core/generator/resource-generator.js';
import type { ResourceField } from '../core/generator/types.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

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
