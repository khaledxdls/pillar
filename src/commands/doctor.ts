import chalk from 'chalk';
import { runDiagnostics, runFixes } from '../core/doctor/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

interface DoctorOptions {
  fix?: boolean;
}

export async function doctorCommand(options: DoctorOptions = {}): Promise<void> {
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

    const fixHint = check.fixable && check.status !== 'pass' ? chalk.dim(' (fixable)') : '';
    console.log(`  ${icon} ${check.message}${fixHint}`);

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

  // Auto-fix mode
  if (options.fix) {
    const fixableCount = report.checks.filter((c) => c.fixable && c.status !== 'pass').length;

    if (fixableCount === 0) {
      logger.info('Nothing to fix — all checks passed.');
      return;
    }

    logger.banner('Applying Fixes');

    const results = await runFixes(projectRoot, report);

    for (const result of results) {
      const icon = result.fixed ? chalk.green('✔') : chalk.red('✖');
      console.log(`  ${icon} ${result.name}: ${result.message}`);
    }

    logger.blank();

    const fixedCount = results.filter((r) => r.fixed).length;
    if (fixedCount > 0) {
      logger.success(`Applied ${fixedCount} fix(es)`);

      // Re-run diagnostics to show updated score
      const updated = await runDiagnostics(projectRoot);
      const newScoreColor =
        updated.score >= 80 ? chalk.green :
        updated.score >= 50 ? chalk.yellow :
        chalk.red;

      console.log(`  Updated health score: ${newScoreColor(`${updated.score}/100`)}`);
      logger.blank();
    }
  } else {
    const fixableCount = report.checks.filter((c) => c.fixable && c.status !== 'pass').length;
    if (fixableCount > 0) {
      logger.info(`${fixableCount} issue(s) can be auto-fixed. Run ${chalk.cyan('pillar doctor --fix')} to apply.`);
      logger.blank();
    }
  }
}
