/**
 * `pillar status` — render a `StatusReport` to a TTY or as JSON.
 *
 * Three modes layered on top of each other:
 *
 *   default    one-shot report; exit 1 if overall=fail
 *   --fix      run idempotent fixes for sections at warn/fail, then
 *              re-render; exit code reflects post-fix overall
 *   --watch    re-render every `--interval` seconds (default 2,
 *              clamped to 1–60). Combined with --fix, fixes self-heal
 *              every iteration.
 *
 * `--watch` and `--json` are mutually exclusive — JSON is for one-shot
 * machine consumption; watching emits ANSI cursor sequences and would
 * corrupt that output.
 */

import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import {
  runStatus,
  runStatusFixes,
  type FixReport,
  type StatusLevel,
  type StatusReport,
} from '../core/status/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

export interface StatusCommandOptions {
  json?: boolean;
  fix?: boolean;
  watch?: boolean;
  interval?: string;
}

const DEFAULT_INTERVAL_S = 2;
const MIN_INTERVAL_S = 1;
const MAX_INTERVAL_S = 60;

export async function statusCommand(options: StatusCommandOptions): Promise<void> {
  if (options.watch && options.json) {
    logger.error(
      '--watch is incompatible with --json',
      'Use --json for one-shot CI output, --watch for an interactive TTY.',
    );
    process.exitCode = 1;
    return;
  }

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

  if (options.watch) {
    const intervalMs = resolveIntervalMs(options.interval);
    if (intervalMs === null) {
      logger.error(
        `--interval must be an integer between ${MIN_INTERVAL_S} and ${MAX_INTERVAL_S} seconds`,
      );
      process.exitCode = 1;
      return;
    }
    await runWatch(projectRoot, intervalMs, options.fix === true);
    return;
  }

  await runOnce(projectRoot, options);
}

// ---------------------------------------------------------------------------
// One-shot mode
// ---------------------------------------------------------------------------

async function runOnce(projectRoot: string, options: StatusCommandOptions): Promise<void> {
  const config = await loadConfig(projectRoot);
  let report = await runStatus(projectRoot, config);
  let fixes: FixReport[] | undefined;

  if (options.fix) {
    fixes = await runStatusFixes(projectRoot, config, report);
    if (fixes.some((f) => f.changed)) {
      report = await runStatus(projectRoot, config);
    }
  }

  if (options.json) {
    const payload = fixes ? { ...report, fixes } : report;
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    renderReport(report);
    if (fixes && fixes.length > 0) renderFixes(fixes);
  }

  if (report.overall === 'fail') process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

/**
 * Watch loop: re-render every `intervalMs`. We use a sleep-and-loop
 * rather than `setInterval` so a slow `runStatus` (e.g., on a large
 * repo) can never overlap with itself. The loop exits cleanly on
 * SIGINT — we install a one-shot handler that sets a flag the loop
 * checks between iterations, restoring cursor visibility on the way
 * out.
 */
async function runWatch(projectRoot: string, intervalMs: number, fixEachIteration: boolean): Promise<void> {
  let stop = false;
  const onSigint = (): void => { stop = true; };
  process.on('SIGINT', onSigint);

  // Hide cursor for a flicker-free render. Restore in `finally`.
  process.stdout.write('\x1b[?25l');

  try {
    while (!stop) {
      const config = await loadConfig(projectRoot);
      let report = await runStatus(projectRoot, config);
      let fixes: FixReport[] | undefined;

      if (fixEachIteration) {
        fixes = await runStatusFixes(projectRoot, config, report);
        if (fixes.some((f) => f.changed)) {
          report = await runStatus(projectRoot, config);
        }
      }

      clearScreen();
      renderReport(report);
      if (fixes && fixes.length > 0) renderFixes(fixes);
      process.stdout.write(
        chalk.dim(`\n  watching · interval ${intervalMs / 1000}s · press Ctrl+C to exit\n`),
      );

      if (stop) break;
      await sleep(intervalMs);
    }
  } finally {
    process.off('SIGINT', onSigint);
    process.stdout.write('\x1b[?25h\n'); // restore cursor + newline
  }
}

function clearScreen(): void {
  // ESC[2J clears the screen; ESC[H homes the cursor. Together, this
  // is the standard "redraw" sequence and is interpreted correctly by
  // every modern terminal we care about.
  process.stdout.write('\x1b[2J\x1b[H');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveIntervalMs(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_INTERVAL_S * 1000;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_S || n > MAX_INTERVAL_S) return null;
  return n * 1000;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

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

function renderFixes(fixes: FixReport[]): void {
  process.stdout.write(`  ${chalk.bold('Fixes applied:')}\n`);
  for (const fix of fixes) {
    const marker = fix.changed ? chalk.green('✓') : chalk.dim('·');
    process.stdout.write(`    ${marker} ${chalk.bold(fix.section.padEnd(11))} ${fix.summary}\n`);
    if (fix.details) {
      for (const d of fix.details) {
        process.stdout.write(`                  ${chalk.dim(d)}\n`);
      }
    }
  }
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
