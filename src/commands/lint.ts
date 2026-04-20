import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { analyzeArchitecture, type Violation } from '../core/architecture-lint/index.js';
import { logger, findProjectRoot } from '../utils/index.js';

interface LintArchitectureOptions {
  /** Exit with code 1 if any violations (default true). */
  strict?: boolean;
  /** Emit machine-readable JSON instead of a human report. */
  json?: boolean;
}

export async function lintArchitectureCommand(options: LintArchitectureOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const report = await analyzeArchitecture(projectRoot, config);

  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    const errorCount = report.violations.filter((v) => v.severity === 'error').length;
    if (errorCount > 0 && options.strict !== false) process.exitCode = 1;
    return;
  }

  logger.banner('Architecture Lint');
  logger.info(`Architecture: ${chalk.cyan(config.project.architecture)}`);
  logger.info(`Files scanned: ${report.filesScanned}`);
  logger.info(`Rules applied: ${report.rulesApplied.join(', ')}`);
  logger.blank();

  if (report.violations.length === 0) {
    logger.success('No violations found.');
    return;
  }

  const grouped = groupByFile(report.violations);
  for (const [file, vs] of grouped) {
    logger.info(chalk.bold(file));
    for (const v of vs) {
      const tag = v.severity === 'error' ? chalk.red('✘') : chalk.yellow('⚠');
      const loc = v.line !== undefined ? chalk.dim(`:${v.line}${v.column !== undefined ? ':' + v.column : ''}`) : '';
      console.log(`  ${tag} ${chalk.dim(v.rule)} ${v.message}${loc}`);
      if (v.hint) console.log(`    ${chalk.dim('→ ' + v.hint)}`);
    }
    logger.blank();
  }

  const errorCount = report.violations.filter((v) => v.severity === 'error').length;
  const warnCount = report.violations.length - errorCount;
  const summary = `${errorCount} error${errorCount === 1 ? '' : 's'}, ${warnCount} warning${warnCount === 1 ? '' : 's'}`;
  if (errorCount > 0) {
    logger.error(summary);
  } else {
    logger.warn(summary);
  }

  if (errorCount > 0 && options.strict !== false) {
    process.exitCode = 1;
  }
}

function groupByFile(violations: Violation[]): Map<string, Violation[]> {
  const out = new Map<string, Violation[]>();
  for (const v of violations) {
    const list = out.get(v.file);
    if (list) list.push(v);
    else out.set(v.file, [v]);
  }
  return out;
}
