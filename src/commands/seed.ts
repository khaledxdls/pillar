import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { generateSeedFile, generateSeedRunner } from '../core/seed/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface SeedGenerateOptions {
  count?: string;
  dryRun?: boolean;
}

export async function seedGenerateCommand(
  resourceName: string,
  options: SeedGenerateOptions,
): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const count = parseInt(options.count ?? '20', 10);

  if (isNaN(count) || count < 1 || count > 10000) {
    logger.error('Count must be between 1 and 10,000.');
    process.exitCode = 1;
    return;
  }

  const seed = await generateSeedFile(projectRoot, config, resourceName, count);

  if (options.dryRun) {
    logger.banner('Dry Run — Seed Generation');
    logger.info(`Resource: ${chalk.cyan(resourceName)}`);
    logger.info(`Records: ${chalk.cyan(String(count))}`);
    logger.info(`File: ${chalk.cyan(seed.relativePath)}`);
    logger.blank();
    logger.info('Preview:');
    logger.blank();
    console.log(chalk.dim(seed.content));
    return;
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Generating seed file for ${resourceName}`, async () => {
    const fullPath = path.join(projectRoot, seed.relativePath);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, seed.content, 'utf-8');
    operations.push({ type: 'create', path: seed.relativePath });
  });

  // Update runner
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const seedDir = path.join(projectRoot, 'src/seeds');
  const existingSeeds = (await fs.pathExists(seedDir))
    ? (await fs.readdir(seedDir)).filter((f) => f.endsWith(`.seed.${ext}`))
    : [path.basename(seed.relativePath)];

  const runner = generateSeedRunner(config, existingSeeds);
  await withSpinner('Updating seed runner', async () => {
    const runnerPath = path.join(projectRoot, runner.relativePath);
    await fs.ensureDir(path.dirname(runnerPath));
    await fs.writeFile(runnerPath, runner.content, 'utf-8');
    operations.push({ type: 'create', path: runner.relativePath });
  });

  // Update map
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    await mapManager.registerEntry(seed.relativePath, seed.purpose);
    await mapManager.registerEntry(runner.relativePath, runner.purpose);
  }

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record(`seed generate ${resourceName}`, operations);

  logger.blank();
  logger.success(`Seed file generated for ${resourceName}`);
  logger.table([
    ['File', seed.relativePath],
    ['Records', String(count)],
    ['Runner', runner.relativePath],
  ]);
  logger.blank();
  logger.info(`Run seeds with: npx tsx ${runner.relativePath}`);
  logger.blank();
}

export async function seedRunCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const runnerPath = path.join(projectRoot, `src/seeds/run.${ext}`);

  if (!(await fs.pathExists(runnerPath))) {
    logger.error('No seed runner found.', 'Run "pillar seed generate <resource>" first.');
    process.exitCode = 1;
    return;
  }

  logger.info('Running seeds...');
  logger.blank();

  try {
    const cmd = ext === 'ts' ? `npx tsx ${runnerPath}` : `node ${runnerPath}`;
    execSync(cmd, { cwd: projectRoot, stdio: 'inherit', timeout: 60_000 });
    logger.blank();
    logger.success('Seeds executed successfully');
  } catch {
    logger.blank();
    logger.error('Seed execution failed');
    process.exitCode = 1;
  }
}
