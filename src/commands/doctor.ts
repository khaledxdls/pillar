import chalk from 'chalk';
import { runDiagnostics } from '../core/doctor/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

export async function doctorCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  logger.banner('Pillar Doctor');

  const report = await runDiagnostics(projectRoot);

  for (const check of report.checks) {
    const icon =
      check.status === 'pass' ? chalk.green('✔') :
      check.status === 'warn' ? chalk.yellow('⚠') :
      chalk.red('✖');

    console.log(`  ${icon} ${check.message}`);

    if (check.details && check.details.length > 0) {
      for (const detail of check.details) {
        console.log(`    ${chalk.dim('→')} ${detail}`);
      }
    }
  }

  logger.blank();

  const scoreColor =
    report.score >= 80 ? chalk.green :
    report.score >= 50 ? chalk.yellow :
    chalk.red;

  console.log(`  Health score: ${scoreColor(`${report.score}/100`)}`);
  logger.blank();
}
