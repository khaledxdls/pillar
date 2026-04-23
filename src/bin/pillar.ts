#!/usr/bin/env node

import { Command, CommanderError } from 'commander';
import chalk from 'chalk';
import { createRequire } from 'node:module';
import { logger } from '../utils/logger.js';
import { PillarError } from '../utils/errors.js';

const require = createRequire(import.meta.url);
const { version } = require('../../package.json') as { version: string };

const program = new Command();

program
  .name('pillar')
  .description('AI-aware architecture engine — scaffold, generate, and maintain production-ready projects')
  .version(version)
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
  .option('-y, --yes', 'Skip prompts and use defaults (may be combined with the non-interactive flags below)')
  .option('--stack <stack>', 'Stack: express, fastify, nestjs, hono, nextjs')
  .option('--category <category>', 'Category: api or fullstack')
  .option('--language <language>', 'Language: typescript or javascript')
  .option('--database <database>', 'Database: postgresql, mongodb, sqlite, none')
  .option('--orm <orm>', 'ORM: prisma, drizzle, typeorm, mongoose, none')
  .option('--architecture <arch>', 'Architecture: feature-first, layered, modular')
  .option('--package-manager <pm>', 'Package manager: npm, yarn, pnpm')
  .option('--test-framework <framework>', 'Test framework: vitest, jest')
  .option('--extras <list>', 'Comma-separated extras: docker,linting,gitHooks')
  .option('--skip-install', 'Skip dependency installation (useful for CI / E2E harnesses)')
  .option('--skip-git', 'Skip git repository initialization')
  .action(async (projectName: string | undefined, options) => {
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

addCmd
  .command('middleware <name>')
  .description('Generate a middleware file. Known kinds (cors, rate-limit, helmet, request-id) get full stack-aware scaffolding; other names fall back to a generic stub.')
  .option('-p, --purpose <text>', 'Purpose (required for generic middleware only when generation.purposeRequired is true)')
  .option('--dry-run', 'Preview without creating')
  .option('-f, --force', 'Overwrite if file exists')
  .option('--files-only', 'Emit files only — skip package.json / env / app-entry wiring (known kinds only)')
  .action(async (name: string, options: { purpose?: string; dryRun?: boolean; force?: boolean; filesOnly?: boolean }) => {
    const { addMiddlewareCommand } = await import('../commands/add.js');
    await addMiddlewareCommand(name, options);
  });

addCmd
  .command('linting')
  .description('Set up ESLint + Prettier with recommended configs')
  .action(async () => {
    const { addLintingCommand } = await import('../commands/linting.js');
    await addLintingCommand();
  });

addCmd
  .command('git-hooks')
  .description('Set up Husky + lint-staged for pre-commit checks')
  .action(async () => {
    const { addGitHooksCommand } = await import('../commands/linting.js');
    await addGitHooksCommand();
  });

addCmd
  .command('field <resource> <fields...>')
  .description('Add fields to an existing resource (e.g., "email:string age:number")')
  .option('-u, --unique', 'Mark fields as unique')
  .option('-o, --optional', 'Mark fields as optional')
  .action(async (resource: string, fields: string[], options: { unique?: boolean; optional?: boolean }) => {
    const { addFieldCommand } = await import('../commands/extensions.js');
    await addFieldCommand(resource, fields, options);
  });

addCmd
  .command('endpoint <resource> <definition>')
  .description('Add an endpoint to a resource (e.g., "GET /users/:id/posts")')
  .option('-p, --purpose <text>', 'Purpose of this endpoint')
  .action(async (resource: string, definition: string, options: { purpose?: string }) => {
    const { addEndpointCommand } = await import('../commands/extensions.js');
    await addEndpointCommand(resource, definition, options);
  });

addCmd
  .command('auth')
  .description('Scaffold an authentication module (JWT strategy)')
  .option('-s, --strategy <strategy>', 'Auth strategy (currently: jwt)', 'jwt')
  .option('--dry-run', 'Preview without creating')
  .option('-f, --force', 'Overwrite existing files')
  .option('--files-only', 'Emit files only — skip package.json / env / app wiring')
  .action(async (options: { strategy?: string; dryRun?: boolean; force?: boolean; filesOnly?: boolean }) => {
    const { addAuthCommand } = await import('../commands/auth.js');
    await addAuthCommand(options);
  });

addCmd
  .command('relation <source> <target>')
  .description('Add a relation between resources (e.g., "user posts --type one-to-many")')
  .option('-t, --type <type>', 'Relation type: one-to-one, one-to-many, many-to-many', 'one-to-many')
  .action(async (source: string, target: string, options: { type?: string }) => {
    const { addRelationCommand } = await import('../commands/extensions.js');
    await addRelationCommand(source, target, options);
  });

// --- pillar map ---
program
  .command('map')
  .description('View, refresh, or validate the project map')
  .option('--refresh', 'Rebuild map from filesystem')
  .option('--validate', 'Check map against actual files')
  .option('--export <format>', 'Export map as json or markdown')
  .option('--purpose <args...>', 'Set the purpose of a file: --purpose <path> "<text>"')
  .action(async (options: { refresh?: boolean; validate?: boolean; export?: string; purpose?: string[] }) => {
    const { mapCommand } = await import('../commands/map.js');
    await mapCommand(options);
  });

// --- pillar ai ---
program
  .command('ai [request]')
  .description('AI-powered feature generation using the project map for context')
  .option('--provider <name>', 'AI provider: openai or anthropic')
  .option('--model <name>', 'Model name override')
  .option('--dry-run', 'Show the plan without executing')
  .option('-y, --yes', 'Skip the confirmation prompt (non-interactive)')
  .option('--print-plan', 'Print the raw plan JSON before applying')
  .option('--retry', 'Re-run the last AI request with tsc errors fed back as extra context')
  .action(async (request: string | undefined, options: { provider?: string; model?: string; dryRun?: boolean; yes?: boolean; printPlan?: boolean; retry?: boolean }) => {
    const { aiCommand } = await import('../commands/ai.js');
    await aiCommand(request, options);
  });

// --- pillar docs ---
const docsCmd = program
  .command('docs')
  .description('API documentation generation');

docsCmd
  .command('generate')
  .description('Generate OpenAPI spec from routes and models')
  .option('-o, --output <path>', 'Output file path', 'docs/openapi.json')
  .action(async (options: { output?: string }) => {
    const { docsGenerateCommand } = await import('../commands/docs.js');
    await docsGenerateCommand(options);
  });

docsCmd
  .command('serve')
  .description('Serve Swagger UI for the generated API docs')
  .option('-p, --port <port>', 'Port to serve on', '4000')
  .option('-o, --output <path>', 'OpenAPI spec file path', 'docs/openapi.json')
  .action(async (options: { port?: string; output?: string }) => {
    const { docsServeCommand } = await import('../commands/docs.js');
    await docsServeCommand(options);
  });

// --- pillar test ---
const testCmd = program
  .command('test')
  .description('Test generation and management');

testCmd
  .command('generate <path>')
  .description('Generate test files for a file or directory')
  .option('--dry-run', 'Preview without creating')
  .option('-f, --force', 'Overwrite existing test files')
  .action(async (targetPath: string, options: { dryRun?: boolean; force?: boolean }) => {
    const { testGenerateCommand } = await import('../commands/test.js');
    await testGenerateCommand(targetPath, options);
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

// --- pillar seed ---
const seedCmd = program
  .command('seed')
  .description('Generate and run seed data');

seedCmd
  .command('generate <resource>')
  .description('Generate a seed file for a resource')
  .option('-c, --count <number>', 'Number of records to generate', '20')
  .option('--dry-run', 'Preview without creating')
  .action(async (resource: string, options: { count?: string; dryRun?: boolean }) => {
    const { seedGenerateCommand } = await import('../commands/seed.js');
    await seedGenerateCommand(resource, options);
  });

seedCmd
  .command('run')
  .description('Execute all seed files')
  .action(async () => {
    const { seedRunCommand } = await import('../commands/seed.js');
    await seedRunCommand();
  });

// --- pillar doctor ---
program
  .command('doctor')
  .description('Run project health diagnostics')
  .option('--fix', 'Auto-fix fixable issues')
  .action(async (options: { fix?: boolean }) => {
    const { doctorCommand } = await import('../commands/doctor.js');
    await doctorCommand(options);
  });

// --- pillar env ---
const envCmd = program
  .command('env')
  .description('Manage environment variables');

envCmd
  .command('validate')
  .description('Check .env against .env.example')
  .action(async () => {
    const { envValidateCommand } = await import('../commands/env.js');
    await envValidateCommand();
  });

envCmd
  .command('sync')
  .description('Add missing keys from .env.example to .env')
  .action(async () => {
    const { envSyncCommand } = await import('../commands/env.js');
    await envSyncCommand();
  });

envCmd
  .command('add <key>')
  .description('Add a new environment variable to .env and .env.example')
  .option('-d, --default <value>', 'Default value for .env.example')
  .option('-c, --comment <text>', 'Comment describing the variable')
  .option('-r, --required', 'Mark as required')
  .action(async (key: string, options: { default?: string; comment?: string; required?: boolean }) => {
    const { envAddCommand } = await import('../commands/env.js');
    await envAddCommand(key, options);
  });

// --- pillar explain ---
program
  .command('explain <path>')
  .description('Explain what a file or folder does based on the project map')
  .action(async (targetPath: string) => {
    const { explainCommand } = await import('../commands/explain.js');
    await explainCommand(targetPath);
  });

// --- pillar lint ---
const lintCmd = program
  .command('lint')
  .description('Static analysis for architecture, imports, and project structure');

lintCmd
  .command('architecture')
  .alias('arch')
  .description('Enforce the architectural pattern chosen at init (feature-first / layered / modular)')
  .option('--no-strict', 'Do not exit with code 1 on errors')
  .option('--json', 'Emit machine-readable JSON for CI integration')
  .action(async (options: { strict?: boolean; json?: boolean }) => {
    const { lintArchitectureCommand } = await import('../commands/lint.js');
    await lintArchitectureCommand(options);
  });

// --- pillar undo ---
program
  .command('undo')
  .description('Undo the last generation operation')
  .action(async () => {
    const { undoCommand } = await import('../commands/undo.js');
    await undoCommand();
  });

// --- pillar rename ---
program
  .command('rename <old-name> <new-name>')
  .description('Rename a resource: folder, files, imports, and map entries')
  .option('--dry-run', 'Preview without renaming')
  .action(async (oldName: string, newName: string, options: { dryRun?: boolean }) => {
    const { renameCommand } = await import('../commands/rename.js');
    await renameCommand(oldName, newName, options);
  });

// --- pillar eject ---
program
  .command('eject')
  .description('Remove Pillar metadata files, leaving generated code intact')
  .action(async () => {
    const { ejectCommand } = await import('../commands/eject.js');
    await ejectCommand();
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
