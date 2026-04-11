import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import type { MapNode } from '../core/map/types.js';
import { logger, findProjectRoot } from '../utils/index.js';

export async function explainCommand(targetPath: string): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const mapManager = new MapManager(projectRoot);
  const map = await mapManager.load();
  if (!map) {
    logger.error('No project map found.', 'Run "pillar map --refresh" to generate one.');
    process.exitCode = 1;
    return;
  }

  // Normalize path: strip trailing slash, resolve relative to project root
  const normalized = targetPath.replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);

  // Walk the map tree to find the node
  let current: Record<string, MapNode> = map.structure;
  let node: MapNode | undefined;
  const parentPurposes: Array<{ name: string; purpose: string }> = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    node = current[part];

    if (!node) {
      logger.error(`"${normalized}" not found in the project map.`);
      logger.info('Run "pillar map --refresh" if the file exists but is not mapped.');
      process.exitCode = 1;
      return;
    }

    if (i < parts.length - 1) {
      parentPurposes.push({ name: parts.slice(0, i + 1).join('/'), purpose: node.purpose });
      if (!node.children) {
        logger.error(`"${normalized}" not found in the project map.`);
        process.exitCode = 1;
        return;
      }
      current = node.children;
    }
  }

  if (!node) {
    logger.error(`"${normalized}" not found in the project map.`);
    process.exitCode = 1;
    return;
  }

  // Display
  logger.blank();
  const isDir = node.children !== undefined;
  const icon = isDir ? '/' : '';
  console.log(`  ${chalk.bold.cyan(normalized + icon)}`);
  console.log(`  ${node.purpose || chalk.dim('(no purpose set)')}`);

  // Show parent context
  if (parentPurposes.length > 0) {
    logger.blank();
    logger.info('Located in:');
    for (const parent of parentPurposes) {
      if (parent.purpose) {
        console.log(`    ${chalk.dim(parent.name + '/')} — ${parent.purpose}`);
      }
    }
  }

  // Show exports and dependencies
  if (node.exports && node.exports.length > 0) {
    logger.blank();
    logger.info('Exports:');
    logger.list(node.exports);
  }

  if (node.depends_on && node.depends_on.length > 0) {
    logger.blank();
    logger.info('Depends on:');
    logger.list(node.depends_on);
  }

  // If it's a directory, show children
  if (node.children) {
    const entries = Object.entries(node.children);
    if (entries.length > 0) {
      logger.blank();
      logger.info(`Contains ${entries.length} item(s):`);
      for (const [name, child] of entries) {
        const childIcon = child.children !== undefined ? '/' : '';
        const purpose = child.purpose || chalk.dim('(no purpose)');
        console.log(`    ${chalk.dim('→')} ${chalk.cyan(name + childIcon)} — ${purpose}`);
      }
    } else {
      logger.blank();
      logger.info(chalk.dim('Empty directory'));
    }
  }

  logger.blank();
}
