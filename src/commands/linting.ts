import path from 'node:path';
import { execSync } from 'node:child_process';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig, writeConfig } from '../core/config/index.js';
import {
  generateLintingFiles,
  generateGitHooksFiles,
  resolveLintingDeps,
  resolveGitHooksDeps,
} from '../core/linting/index.js';
import { HistoryManager, type FileOperation } from '../core/history/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

export async function addLintingCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const operations: FileOperation[] = [];

  // Generate config files
  const files = generateLintingFiles(config);

  await withSpinner('Creating ESLint and Prettier configs', async () => {
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

  // Install dependencies
  const { devDeps } = resolveLintingDeps(config);
  const pm = config.project.packageManager;
  const installCmd =
    pm === 'yarn' ? `yarn add -D ${devDeps.join(' ')}` :
    pm === 'pnpm' ? `pnpm add -D ${devDeps.join(' ')}` :
    `npm install -D ${devDeps.join(' ')}`;

  await withSpinner(`Installing linting dependencies (${devDeps.length} packages)`, async (spinner) => {
    try {
      execSync(installCmd, { cwd: projectRoot, stdio: 'pipe', timeout: 120_000 });
    } catch {
      spinner.warn('Dependency installation failed — run the install command manually');
    }
  });

  // Add scripts to package.json
  await withSpinner('Updating package.json scripts', async () => {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (await fs.pathExists(pkgPath)) {
      const pkg = await fs.readJson(pkgPath);
      const scripts = (pkg.scripts ?? {}) as Record<string, string>;
      if (!scripts['lint']) scripts['lint'] = 'eslint src/';
      if (!scripts['lint:fix']) scripts['lint:fix'] = 'eslint src/ --fix';
      if (!scripts['format']) scripts['format'] = 'prettier --write src/';
      if (!scripts['format:check']) scripts['format:check'] = 'prettier --check src/';
      pkg.scripts = scripts;
      await fs.writeJson(pkgPath, pkg, { spaces: 2 });
    }
  });

  // Update config
  config.extras.linting = true;
  await writeConfig(projectRoot, config);

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record('add linting', operations);

  logger.blank();
  logger.success('Linting and formatting configured');
  logger.blank();
  logger.info('Available scripts:');
  logger.list([
    `${pm === 'npm' ? 'npm run' : pm} lint        — check for issues`,
    `${pm === 'npm' ? 'npm run' : pm} lint:fix    — auto-fix issues`,
    `${pm === 'npm' ? 'npm run' : pm} format      — format all files`,
    `${pm === 'npm' ? 'npm run' : pm} format:check — check formatting`,
  ]);
  logger.blank();
}

export async function addGitHooksCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);

  if (!config.extras.linting) {
    logger.warn('Linting is not set up yet.');
    logger.info('Run "pillar add linting" first, then add git hooks.');
    process.exitCode = 1;
    return;
  }

  const operations: FileOperation[] = [];
  const files = generateGitHooksFiles(config);

  await withSpinner('Creating git hook configs', async () => {
    for (const file of files) {
      const fullPath = path.join(projectRoot, file.relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, file.content, 'utf-8');

      // Make hook scripts executable
      if (file.relativePath.startsWith('.husky/')) {
        await fs.chmod(fullPath, 0o755);
      }

      operations.push({ type: 'create', path: file.relativePath });
    }
  });

  // Install dependencies
  const { devDeps } = resolveGitHooksDeps();
  const pm = config.project.packageManager;
  const installCmd =
    pm === 'yarn' ? `yarn add -D ${devDeps.join(' ')}` :
    pm === 'pnpm' ? `pnpm add -D ${devDeps.join(' ')}` :
    `npm install -D ${devDeps.join(' ')}`;

  await withSpinner('Installing husky and lint-staged', async (spinner) => {
    try {
      execSync(installCmd, { cwd: projectRoot, stdio: 'pipe', timeout: 120_000 });
    } catch {
      spinner.warn('Dependency installation failed — run the install command manually');
    }
  });

  // Initialize husky
  await withSpinner('Initializing husky', async (spinner) => {
    try {
      execSync('npx husky', { cwd: projectRoot, stdio: 'pipe', timeout: 30_000 });
    } catch {
      spinner.warn('Husky init failed — run "npx husky" manually');
    }
  });

  // Update config
  config.extras.gitHooks = true;
  await writeConfig(projectRoot, config);

  const history = new HistoryManager(projectRoot);
  await history.record('add git-hooks', operations);

  logger.blank();
  logger.success('Git hooks configured');
  logger.info('Pre-commit hook will run ESLint and Prettier on staged files.');
  logger.blank();
}
