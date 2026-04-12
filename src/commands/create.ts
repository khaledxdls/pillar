import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import { generateSkeleton } from '../core/generator/skeleton.js';
import { logger, findProjectRoot } from '../utils/index.js';
import { PillarError, FileExistsError } from '../utils/errors.js';

interface CreateOptions {
  purpose: string;
  force?: boolean;
  dryRun?: boolean;
}

export async function createCommand(filePath: string, options: CreateOptions): Promise<void> {
  const { purpose, force, dryRun } = options;

  if (!purpose) {
    logger.error(
      'Purpose is required.',
      'Use -p "describe what this file does"',
    );
    process.exitCode = 1;
    return;
  }

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
  const fullPath = path.join(projectRoot, filePath);
  const relativePath = path.relative(projectRoot, fullPath);
  const fileName = path.basename(filePath);
  const hasExtension = path.extname(fileName) !== '';
  const isDirectory = filePath.endsWith('/') || !hasExtension;

  if (dryRun) {
    logger.banner('Dry Run');

    if (isDirectory) {
      logger.info(`Would create directory: ${chalk.cyan(relativePath)}`);
      logger.info(`Would register in map with purpose: "${purpose}"`);
    } else {
      const content = generateSkeleton(fileName, purpose, {
        stack: config.project.stack,
        language: config.project.language,
      });
      logger.info(`Would create file: ${chalk.cyan(relativePath)}`);
      logger.info(`Would register in map with purpose: "${purpose}"`);
      logger.blank();
      logger.info('Content preview:');
      logger.blank();
      console.log(chalk.dim(content || '(empty file)'));
    }
    return;
  }

  // Check for existing file
  if (!force && (await fs.pathExists(fullPath))) {
    if (isDirectory) {
      // Directories are fine to "create" if they exist — just register
    } else {
      throw new FileExistsError(relativePath);
    }
  }

  if (isDirectory) {
    const dirExists = await fs.pathExists(fullPath);
    await fs.ensureDir(fullPath);
    if (dirExists) {
      logger.warn(`Directory already exists: ${chalk.cyan(relativePath)} — updating purpose.`);
    } else {
      logger.success(`Created directory: ${chalk.cyan(relativePath)}`);
    }
  } else {
    const content = generateSkeleton(fileName, purpose, {
      stack: config.project.stack,
      language: config.project.language,
    });

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    logger.success(`Created file: ${chalk.cyan(relativePath)}`);
  }

  // Register in map
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    await mapManager.registerEntry(relativePath, purpose);
    logger.info(`Registered in project map: "${purpose}"`);
  }

  // Record in history
  const historyManager = new HistoryManager(projectRoot);
  await historyManager.record(`create ${filePath}`, [
    { type: 'create', path: relativePath },
  ]);
}
