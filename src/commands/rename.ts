import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import type { FileOperation } from '../core/history/types.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';
import { resolveResourcePath, resolveResourceFilePath, LAYERED_DIRS } from '../utils/resolve-resource-path.js';
import { escapeRegex } from '../utils/sanitize.js';

interface RenameOptions {
  dryRun?: boolean;
}

/**
 * Rename a feature/resource: renames the folder, all contained files,
 * updates import references across the project, and refreshes the map.
 */
export async function renameCommand(
  oldName: string,
  newName: string,
  options: RenameOptions = {},
): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  if (oldName === newName) {
    logger.warn('Old and new names are the same — nothing to do.');
    return;
  }

  if (!/^[a-z][a-z0-9-]*$/.test(newName)) {
    logger.error(
      'Invalid resource name.',
      'Use lowercase alphanumeric with hyphens (e.g., "user-profile").',
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const arch = config.project.architecture;

  if (arch === 'layered') {
    await renameLayered(projectRoot, config, oldName, newName, options);
    return;
  }

  const basePath = resolveResourcePath(arch, oldName);
  const oldDir = path.join(projectRoot, basePath);

  if (!(await fs.pathExists(oldDir))) {
    logger.error(`Resource "${oldName}" not found at ${basePath}`);
    process.exitCode = 1;
    return;
  }

  const newBasePath = resolveResourcePath(arch, newName);
  const newDir = path.join(projectRoot, newBasePath);

  if (await fs.pathExists(newDir)) {
    logger.error(`Target "${newName}" already exists at ${newBasePath}`);
    process.exitCode = 1;
    return;
  }

  // Discover all files to rename
  const filesToRename = await discoverFiles(oldDir);
  const renamedFiles = filesToRename.map((f) => ({
    oldPath: f,
    newPath: f.replace(new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g'), newName),
    oldRelative: path.relative(projectRoot, f),
    newRelative: path.relative(projectRoot, f.replace(new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g'), newName))
      .replace(basePath, newBasePath),
  }));

  // Discover files that import from the old resource (for updating imports)
  const srcDir = path.join(projectRoot, 'src');
  const importUpdates = await findImportReferences(srcDir, oldName, newName, oldDir);

  logger.banner('Rename Plan');
  logger.info(`Rename: ${chalk.cyan(oldName)} → ${chalk.cyan(newName)}`);
  logger.blank();

  if (renamedFiles.length > 0) {
    logger.info(`${renamedFiles.length} file(s) to rename:`);
    for (const f of renamedFiles) {
      console.log(`  ${chalk.red(f.oldRelative)} → ${chalk.green(f.newRelative)}`);
    }
    logger.blank();
  }

  if (importUpdates.length > 0) {
    logger.info(`${importUpdates.length} file(s) with import references to update:`);
    for (const f of importUpdates) {
      console.log(`  ${chalk.yellow('~')} ${chalk.cyan(path.relative(projectRoot, f.filePath))}`);
    }
    logger.blank();
  }

  if (options.dryRun) {
    logger.info(chalk.dim('Dry run — no files were changed.'));
    return;
  }

  // Confirm
  const inquirer = await import('inquirer');
  const { proceed } = await inquirer.default.prompt<{ proceed: boolean }>([{
    type: 'confirm',
    name: 'proceed',
    message: 'Apply rename?',
    default: true,
  }]);

  if (!proceed) {
    logger.info('Aborted.');
    return;
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Renaming ${oldName} → ${newName}`, async () => {
    // 1. Update import references in files OUTSIDE the resource directory first
    for (const ref of importUpdates) {
      const content = await fs.readFile(ref.filePath, 'utf-8');
      const updated = ref.updater(content);
      if (updated !== content) {
        operations.push({ type: 'modify', path: path.relative(projectRoot, ref.filePath), previousContent: content });
        await fs.writeFile(ref.filePath, updated, 'utf-8');
      }
    }

    // 2. Update content inside resource files (before moving them)
    for (const file of filesToRename) {
      const content = await fs.readFile(file, 'utf-8');
      const updated = replaceResourceName(content, oldName, newName);
      if (updated !== content) {
        operations.push({ type: 'modify', path: path.relative(projectRoot, file), previousContent: content });
        await fs.writeFile(file, updated, 'utf-8');
      }
    }

    // 3. Move the entire directory, then rename individual files.
    const filesBefore = await discoverFiles(oldDir);
    const fileRelPaths = filesBefore.map((f) => path.relative(oldDir, f));

    await fs.ensureDir(path.dirname(newDir));
    await fs.move(oldDir, newDir);

    operations.push({
      type: 'move',
      path: path.relative(projectRoot, newDir),
      fromPath: path.relative(projectRoot, oldDir),
    });

    // 4. Rename individual files inside the new directory
    for (const relFile of fileRelPaths) {
      const currentPath = path.join(newDir, relFile);
      const basename = path.basename(relFile);
      const newBasename = basename.replace(new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g'), newName);

      if (newBasename !== basename) {
        const dirInNew = path.dirname(currentPath);
        const newFilePath = path.join(dirInNew, newBasename);
        await fs.move(currentPath, newFilePath);

        operations.push({
          type: 'move',
          path: path.relative(projectRoot, newFilePath),
          fromPath: path.relative(projectRoot, currentPath),
        });
      }
    }
  });

  // 5. Refresh map
  if (config.map.autoUpdate) {
    await withSpinner('Refreshing project map', async () => {
      const mapManager = new MapManager(projectRoot);
      await mapManager.refresh(config);
    });
  }

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record(`rename ${oldName} ${newName}`, operations);

  logger.blank();
  logger.success(`Renamed ${chalk.cyan(oldName)} → ${chalk.cyan(newName)}`);
  logger.blank();
}

/**
 * Rename for layered architecture: files are scattered across subdirectories
 * (src/models/, src/services/, etc.) so we rename each file individually.
 */
async function renameLayered(
  projectRoot: string,
  config: import('../core/config/index.js').PillarConfig,
  oldName: string,
  newName: string,
  options: RenameOptions,
): Promise<void> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';

  // Discover existing resource files across layered subdirectories
  const filePairs: Array<{ oldPath: string; newPath: string; oldRel: string; newRel: string }> = [];
  for (const [suffix, dir] of Object.entries(LAYERED_DIRS)) {
    const oldFile = path.join(projectRoot, 'src', dir, `${oldName}.${suffix}.${ext}`);
    if (await fs.pathExists(oldFile)) {
      const newFile = path.join(projectRoot, 'src', dir, `${newName}.${suffix}.${ext}`);
      filePairs.push({
        oldPath: oldFile,
        newPath: newFile,
        oldRel: path.relative(projectRoot, oldFile),
        newRel: path.relative(projectRoot, newFile),
      });
    }
  }

  if (filePairs.length === 0) {
    logger.error(`Resource "${oldName}" not found in any layered directory`);
    process.exitCode = 1;
    return;
  }

  // Check for conflicts
  for (const pair of filePairs) {
    if (await fs.pathExists(pair.newPath)) {
      logger.error(`Target file already exists: ${pair.newRel}`);
      process.exitCode = 1;
      return;
    }
  }

  const srcDir = path.join(projectRoot, 'src');
  const importUpdates = await findImportReferences(srcDir, oldName, newName, '');

  logger.banner('Rename Plan');
  logger.info(`Rename: ${chalk.cyan(oldName)} → ${chalk.cyan(newName)} (layered)`);
  logger.blank();
  logger.info(`${filePairs.length} file(s) to rename:`);
  for (const f of filePairs) {
    console.log(`  ${chalk.red(f.oldRel)} → ${chalk.green(f.newRel)}`);
  }
  logger.blank();

  if (importUpdates.length > 0) {
    logger.info(`${importUpdates.length} file(s) with import references to update:`);
    for (const f of importUpdates) {
      console.log(`  ${chalk.yellow('~')} ${chalk.cyan(path.relative(projectRoot, f.filePath))}`);
    }
    logger.blank();
  }

  if (options.dryRun) {
    logger.info(chalk.dim('Dry run — no files were changed.'));
    return;
  }

  const inquirer = await import('inquirer');
  const { proceed } = await inquirer.default.prompt<{ proceed: boolean }>([{
    type: 'confirm',
    name: 'proceed',
    message: 'Apply rename?',
    default: true,
  }]);

  if (!proceed) {
    logger.info('Aborted.');
    return;
  }

  const operations: FileOperation[] = [];

  await withSpinner(`Renaming ${oldName} → ${newName}`, async () => {
    // 1. Update import references outside resource files
    for (const ref of importUpdates) {
      const content = await fs.readFile(ref.filePath, 'utf-8');
      const updated = ref.updater(content);
      if (updated !== content) {
        operations.push({ type: 'modify', path: path.relative(projectRoot, ref.filePath), previousContent: content });
        await fs.writeFile(ref.filePath, updated, 'utf-8');
      }
    }

    // 2. Update content inside resource files, then rename
    for (const pair of filePairs) {
      const content = await fs.readFile(pair.oldPath, 'utf-8');
      const updated = replaceResourceName(content, oldName, newName);
      if (updated !== content) {
        operations.push({ type: 'modify', path: pair.oldRel, previousContent: content });
        await fs.writeFile(pair.oldPath, updated, 'utf-8');
      }

      await fs.move(pair.oldPath, pair.newPath);
      operations.push({ type: 'move', path: pair.newRel, fromPath: pair.oldRel });
    }
  });

  // Refresh map
  if (config.map.autoUpdate) {
    await withSpinner('Refreshing project map', async () => {
      const mapManager = new MapManager(projectRoot);
      await mapManager.refresh(config);
    });
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`rename ${oldName} ${newName}`, operations);

  logger.blank();
  logger.success(`Renamed ${chalk.cyan(oldName)} → ${chalk.cyan(newName)}`);
  logger.blank();
}

async function discoverFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  await walk(dir);
  return files;
}

interface ImportReference {
  filePath: string;
  updater: (content: string) => string;
}

/**
 * Find files outside the resource directory that import from it.
 */
async function findImportReferences(
  srcDir: string,
  oldName: string,
  newName: string,
  oldResourceDir: string,
): Promise<ImportReference[]> {
  const refs: ImportReference[] = [];
  if (!(await fs.pathExists(srcDir))) return refs;

  const pattern = new RegExp(`['"]([^'"]*\\b${escapeRegex(oldName)}\\b[^'"]*)['"]`, 'g');

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip the resource's own directory — already handled
        if (fullPath === oldResourceDir) continue;
        await walk(fullPath);
        continue;
      }

      if (!/\.(ts|js|tsx|jsx)$/.test(entry.name)) continue;

      const content = await fs.readFile(fullPath, 'utf-8');
      if (pattern.test(content)) {
        pattern.lastIndex = 0; // Reset for next test
        refs.push({
          filePath: fullPath,
          updater: (c: string) => replaceResourceName(c, oldName, newName),
        });
      }
      pattern.lastIndex = 0;
    }
  }

  await walk(srcDir);
  return refs;
}

/**
 * Replace all occurrences of a resource name in content,
 * handling both the raw name and PascalCase variants.
 */
/**
 * HTTP methods and other common identifiers that should never be renamed,
 * even if they match a resource name like "post" or "get".
 */
const PROTECTED_IDENTIFIERS = new Set([
  'get', 'post', 'put', 'patch', 'delete', 'head', 'options',
  'use', 'all', 'listen', 'send', 'json', 'status',
]);

function replaceResourceName(content: string, oldName: string, newName: string): string {
  let updated = content;

  // Replace PascalCase first (e.g., PostController → ArticleController, PostService → ArticleService)
  // Use lookahead instead of \b at the end, since PascalCase names are prefixes in compound identifiers
  const oldPascal = toPascalCase(oldName);
  const newPascal = toPascalCase(newName);
  if (oldPascal !== newPascal) {
    updated = updated.replace(new RegExp(`\\b${escapeRegex(oldPascal)}(?=[A-Z]|\\b)`, 'g'), newPascal);
  }

  // Replace camelCase (e.g., postService → articleService, postRouter → articleRouter)
  // Use negative lookbehind for . to avoid matching method calls like router.post()
  const oldCamel = toCamelCase(oldName);
  const newCamel = toCamelCase(newName);
  if (oldCamel !== newCamel) {
    updated = updated.replace(new RegExp(`(?<!\\.)\\b${escapeRegex(oldCamel)}(?=[A-Z])`, 'g'), newCamel);
  }

  // Replace raw name in safe contexts (import paths, file references, comments, strings)
  // but NOT when it's a standalone identifier that could be an HTTP method like .post() or .get()
  if (!PROTECTED_IDENTIFIERS.has(oldName.toLowerCase())) {
    updated = updated.replace(new RegExp(`\\b${escapeRegex(oldName)}\\b`, 'g'), newName);
  } else {
    // For protected names like "post", only replace in import paths and string literals
    // Replace in import paths: from './post.service.js' or from '../post/'
    updated = updated.replace(
      new RegExp(`(from\\s+['"][^'"]*?)\\b${escapeRegex(oldName)}\\b([^'"]*?['"])`, 'g'),
      `$1${newName}$2`,
    );
    // Replace in comments
    updated = updated.replace(
      new RegExp(`(//.*?)\\b${escapeRegex(oldName)}\\b`, 'g'),
      `$1${newName}`,
    );
  }

  return updated;
}

function toPascalCase(name: string): string {
  return name
    .split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

// escapeRegex is now imported from utils/sanitize.js
