import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { logger, findProjectRoot } from '../utils/index.js';
import { PILLAR_DIR, CONFIG_FILE } from '../utils/constants.js';

export async function ejectCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Nothing to eject.');
    process.exitCode = 1;
    return;
  }

  const pillarDir = path.join(projectRoot, PILLAR_DIR);
  const configFile = path.join(projectRoot, CONFIG_FILE);

  const toRemove: string[] = [];
  if (await fs.pathExists(pillarDir)) toRemove.push(PILLAR_DIR);
  if (await fs.pathExists(configFile)) toRemove.push(CONFIG_FILE);

  if (toRemove.length === 0) {
    logger.info('No Pillar files found — already ejected.');
    return;
  }

  logger.banner('Pillar Eject');
  logger.info('This will remove all Pillar metadata files:');
  logger.list(toRemove.map((f) => chalk.cyan(f)));
  logger.blank();
  logger.info(chalk.dim('Your generated source code will NOT be modified.'));
  logger.blank();

  const inquirer = await import('inquirer');
  const { confirm } = await inquirer.default.prompt<{ confirm: boolean }>([{
    type: 'confirm',
    name: 'confirm',
    message: 'Proceed with eject?',
    default: false,
  }]);

  if (!confirm) {
    logger.info('Aborted.');
    return;
  }

  if (await fs.pathExists(pillarDir)) {
    await fs.remove(pillarDir);
  }
  if (await fs.pathExists(configFile)) {
    await fs.remove(configFile);
  }

  logger.blank();
  logger.success('Ejected successfully');
  logger.info('Your project code is untouched. Pillar metadata has been removed.');
  logger.info(chalk.dim('You can re-initialize anytime with "pillar init".'));
  logger.blank();
}
