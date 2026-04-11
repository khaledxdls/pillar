import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { generateTestsForPath } from '../core/testing/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface TestGenerateOptions {
  dryRun?: boolean;
  force?: boolean;
}

export async function testGenerateCommand(
  targetPath: string,
  options: TestGenerateOptions,
): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const fullTarget = path.join(projectRoot, targetPath);

  if (!(await fs.pathExists(fullTarget))) {
    logger.error(`Path not found: ${targetPath}`);
    process.exitCode = 1;
    return;
  }

  const files = await generateTestsForPath(
    { projectRoot, config, testFramework: config.generation.testFramework },
    targetPath,
  );

  if (files.length === 0) {
    logger.info('No test files to generate — tests already exist for all source files.');
    return;
  }

  if (options.dryRun) {
    logger.banner('Dry Run — Test Generation');
    logger.info(`Tests to generate: ${chalk.cyan(String(files.length))}`);
    logger.blank();
    for (const file of files) {
      console.log(`  ${chalk.dim('→')} ${chalk.cyan(file.relativePath)}`);
      console.log(`    ${chalk.dim(file.purpose)}`);
    }
    return;
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Generating ${files.length} test file(s)`, async () => {
    for (const file of files) {
      const fullPath = path.join(projectRoot, file.relativePath);

      if (!options.force && (await fs.pathExists(fullPath))) {
        continue;
      }

      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, file.content, 'utf-8');
      operations.push({ type: 'create', path: file.relativePath });
    }
  });

  // Update map
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    for (const file of files) {
      await mapManager.registerEntry(file.relativePath, file.purpose);
    }
  }

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record(`test generate ${targetPath}`, operations);

  logger.blank();
  logger.success(`Generated ${operations.length} test file(s)`);
  logger.info('Files created:');
  logger.list(operations.map((o) => o.path));
  logger.blank();
}
