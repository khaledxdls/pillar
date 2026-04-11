import chalk from 'chalk';

type LogLevel = 'info' | 'success' | 'warn' | 'error' | 'debug';

const PREFIXES: Record<LogLevel, string> = {
  info: chalk.blue('info'),
  success: chalk.green('done'),
  warn: chalk.yellow('warn'),
  error: chalk.red('error'),
  debug: chalk.gray('debug'),
};

let verbose = false;

export const logger = {
  setVerbose(enabled: boolean): void {
    verbose = enabled;
  },

  info(message: string): void {
    console.log(`  ${PREFIXES.info}  ${message}`);
  },

  success(message: string): void {
    console.log(`  ${PREFIXES.success}  ${chalk.green(message)}`);
  },

  warn(message: string): void {
    console.log(`  ${PREFIXES.warn}  ${chalk.yellow(message)}`);
  },

  error(message: string, hint?: string): void {
    console.error(`  ${PREFIXES.error}  ${chalk.red(message)}`);
    if (hint) {
      console.error(`         ${chalk.dim(hint)}`);
    }
  },

  debug(message: string): void {
    if (verbose) {
      console.log(`  ${PREFIXES.debug}  ${chalk.gray(message)}`);
    }
  },

  blank(): void {
    console.log();
  },

  banner(text: string): void {
    console.log();
    console.log(`  ${chalk.bold.cyan(text)}`);
    console.log();
  },

  list(items: string[]): void {
    for (const item of items) {
      console.log(`    ${chalk.dim('→')} ${item}`);
    }
  },

  table(rows: Array<[string, string]>): void {
    const maxKey = Math.max(...rows.map(([k]) => k.length));
    for (const [key, value] of rows) {
      console.log(`    ${chalk.dim(key.padEnd(maxKey))}  ${value}`);
    }
  },
};
