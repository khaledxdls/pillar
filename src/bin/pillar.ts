#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { PillarError } from '../utils/errors.js';

const program = new Command();

program
  .name('pillar')
  .description('AI-aware architecture engine — scaffold, generate, and maintain production-ready projects')
  .version('0.1.0')
  .option('-v, --verbose', 'Enable verbose logging')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    if (opts['verbose']) {
      logger.setVerbose(true);
    }
  });

// --- pillar init ---
program
  .command('init [project-name]')
  .description('Initialize a new project with an interactive wizard')
  .option('-y, --yes', 'Skip prompts and use defaults')
  .action(async (projectName: string | undefined, options: { yes?: boolean }) => {
    const { initCommand } = await import('../commands/init.js');
    await initCommand(projectName, options);
  });

// --- pillar create ---
program
  .command('create <file-path>')
  .alias('c')
  .description('Create a file or directory with a registered purpose')
  .requiredOption('-p, --purpose <purpose>', 'Purpose of the file (required)')
  .option('-f, --force', 'Overwrite if file exists')
  .option('--dry-run', 'Preview without creating')
  .action(async (filePath: string, options: { purpose: string; force?: boolean; dryRun?: boolean }) => {
    const { createCommand } = await import('../commands/create.js');
    await createCommand(filePath, options);
  });

// --- pillar add ---
const addCmd = program
  .command('add')
  .description('Add resources, features, or extensions to the project');

addCmd
  .command('resource <name>')
  .description('Generate a full resource (model, service, controller, tests, etc.)')
  .option('--fields <fields>', 'Field definitions (e.g., "name:string email:string")')
  .option('--no-test', 'Skip test file generation')
  .option('--only <types>', 'Generate only specific files (e.g., "service,controller")')
  .option('--dry-run', 'Preview without creating')
  .option('-f, --force', 'Overwrite existing files')
  .action(async (name: string, options) => {
    const { addResourceCommand } = await import('../commands/add.js');
    await addResourceCommand(name, options);
  });

// --- pillar map ---
program
  .command('map')
  .description('View, refresh, or validate the project map')
  .option('--refresh', 'Rebuild map from filesystem')
  .option('--validate', 'Check map against actual files')
  .option('--export <format>', 'Export map as json or markdown')
  .action(async (options: { refresh?: boolean; validate?: boolean; export?: string }) => {
    const { mapCommand } = await import('../commands/map.js');
    await mapCommand(options);
  });

// --- pillar config ---
const configCmd = program
  .command('config')
  .description('View or modify project configuration');

configCmd
  .command('get <key>')
  .description('Get a configuration value')
  .action(async (key: string) => {
    const { configGetCommand } = await import('../commands/config.js');
    await configGetCommand(key);
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action(async (key: string, value: string) => {
    const { configSetCommand } = await import('../commands/config.js');
    await configSetCommand(key, value);
  });

configCmd
  .command('list')
  .description('Show full configuration')
  .action(async () => {
    const { configListCommand } = await import('../commands/config.js');
    await configListCommand();
  });

// --- pillar doctor ---
program
  .command('doctor')
  .description('Run project health diagnostics')
  .action(async () => {
    const { doctorCommand } = await import('../commands/doctor.js');
    await doctorCommand();
  });

// --- pillar explain ---
program
  .command('explain <path>')
  .description('Explain what a file or folder does based on the project map')
  .action(async (targetPath: string) => {
    const { explainCommand } = await import('../commands/explain.js');
    await explainCommand(targetPath);
  });

// --- pillar undo ---
program
  .command('undo')
  .description('Undo the last generation operation')
  .action(async () => {
    const { undoCommand } = await import('../commands/undo.js');
    await undoCommand();
  });

// --- Global error handling ---
program.exitOverride();

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof CommanderError) {
      // Commander throws for --help / --version — exit cleanly
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof PillarError) {
      logger.error(error.message, error.hint);
      process.exitCode = 1;
    } else if (error instanceof Error) {
      logger.error(error.message);
      logger.debug(error.stack ?? '');
      process.exitCode = 1;
    }
  }
}

main();
