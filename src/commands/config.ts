import chalk from 'chalk';
import { loadConfig, writeConfig, getConfigValue, setConfigValue } from '../core/config/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

export async function configGetCommand(keyPath: string): Promise<void> {
  const projectRoot = await requireProjectRoot();
  if (!projectRoot) return;

  const config = await loadConfig(projectRoot);
  const value = getConfigValue(config, keyPath);

  if (value === undefined) {
    logger.warn(`Key "${keyPath}" not found in config`);
    process.exitCode = 1;
    return;
  }

  if (typeof value === 'object') {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(String(value));
  }
}

export async function configSetCommand(keyPath: string, value: string): Promise<void> {
  const projectRoot = await requireProjectRoot();
  if (!projectRoot) return;

  const config = await loadConfig(projectRoot);

  // Parse value: booleans, numbers, or keep as string
  let parsed: unknown = value;
  if (value === 'true') parsed = true;
  else if (value === 'false') parsed = false;
  else if (!isNaN(Number(value)) && value !== '') parsed = Number(value);

  const updated = setConfigValue(config, keyPath, parsed);
  await writeConfig(projectRoot, updated);

  logger.success(`Set ${chalk.cyan(keyPath)} = ${chalk.yellow(String(parsed))}`);
}

export async function configListCommand(): Promise<void> {
  const projectRoot = await requireProjectRoot();
  if (!projectRoot) return;

  const config = await loadConfig(projectRoot);
  console.log(JSON.stringify(config, null, 2));
}

async function requireProjectRoot(): Promise<string | null> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error(
      'Not inside a Pillar project.',
      'Run "pillar init" first.',
    );
    process.exitCode = 1;
    return null;
  }
  return projectRoot;
}
