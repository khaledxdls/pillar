/**
 * `pillar status` — render a `StatusReport` to a TTY or as JSON.
 *
 * Sets `process.exitCode = 1` when the aggregate level is `fail` so the
 * command is wireable into CI shell scripts (`pillar status || exit`).
 * `warn` is intentionally exit 0 — drift is informational, not a build
 * breaker.
 */

import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { runStatus, type StatusLevel, type StatusReport } from '../core/status/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

export interface StatusCommandOptions {
  json?: boolean;
}

export async function statusCommand(options: StatusCommandOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ error: 'not-a-pillar-project' }) + '\n');
    } else {
      logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    }
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const report = await runStatus(projectRoot, config);

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    renderReport(report);
  }

  if (report.overall === 'fail') process.exitCode = 1;
}

function renderReport(report: StatusReport): void {
  logger.banner(`pillar status — ${report.project.name}`);

  logger.table([
    ['Stack', report.project.stack],
    ['Language', report.project.language],
    ['Architecture', report.project.architecture],
    ['Database', `${report.project.database} (${report.project.orm})`],
    ['Package mgr', report.project.packageManager],
  ]);

  logger.blank();

  for (const section of report.sections) {
    const badge = badgeFor(section.level);
    process.stdout.write(`  ${badge}  ${chalk.bold(section.name.padEnd(11))} ${section.summary}\n`);
    if (section.details && section.details.length > 0) {
      for (const detail of section.details) {
        process.stdout.write(`              ${chalk.dim(detail)}\n`);
      }
    }
  }

  logger.blank();
  process.stdout.write(`  Overall: ${badgeFor(report.overall)}  ${overallMessage(report.overall)}\n`);
  logger.blank();
}

function badgeFor(level: StatusLevel): string {
  switch (level) {
    case 'ok': return chalk.bgGreen.black(' OK   ');
    case 'warn': return chalk.bgYellow.black(' WARN ');
    case 'fail': return chalk.bgRed.white(' FAIL ');
  }
}

function overallMessage(level: StatusLevel): string {
  switch (level) {
    case 'ok': return chalk.green('healthy');
    case 'warn': return chalk.yellow('healthy with drift — see warnings above');
    case 'fail': return chalk.red('action required — fix the failing sections');
  }
}
