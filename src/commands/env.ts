import chalk from 'chalk';
import { EnvManager } from '../core/env/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

export async function envValidateCommand(): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const env = new EnvManager(projectRoot);
  const result = await env.validate();

  if (result.valid && result.extraInEnv.length === 0) {
    logger.success('Environment variables are in sync with .env.example');
    return;
  }

  if (result.missingInEnv.length > 0) {
    logger.error(`${result.missingInEnv.length} key(s) missing from .env:`);
    logger.list(result.missingInEnv);
    logger.blank();
  }

  if (result.emptyRequired.length > 0) {
    logger.warn(`${result.emptyRequired.length} key(s) have empty values in .env:`);
    logger.list(result.emptyRequired);
    logger.blank();
  }

  if (result.extraInEnv.length > 0) {
    logger.warn(`${result.extraInEnv.length} key(s) in .env not defined in .env.example:`);
    logger.list(result.extraInEnv);
    logger.blank();
  }

  if (result.missingInEnv.length > 0) {
    logger.info('Run "pillar env sync" to add missing keys to .env');
  }
}

export async function envSyncCommand(): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const env = new EnvManager(projectRoot);
  const result = await env.sync();

  if (result.added.length === 0) {
    logger.success('.env is already in sync with .env.example');
    return;
  }

  logger.success(`Added ${result.added.length} key(s) to .env:`);
  logger.list(result.added);
  logger.blank();
  logger.info('Fill in the values for the newly added keys.');
}

export async function envAddCommand(
  key: string,
  options: { default?: string; comment?: string; required?: boolean },
): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const env = new EnvManager(projectRoot);

  try {
    await env.addVariable(key, {
      defaultValue: options.default,
      comment: options.comment,
      required: options.required,
    });
    logger.success(`Added ${chalk.cyan(key)} to .env.example and .env`);
  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
      process.exitCode = 1;
    }
  }
}

async function requireProject(): Promise<string | null> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return null;
  }
  return projectRoot;
}
