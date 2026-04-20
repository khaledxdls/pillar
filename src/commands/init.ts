import path from 'node:path';
import inquirer from 'inquirer';
import fs from 'fs-extra';
import chalk from 'chalk';
import { type PillarConfig, writeConfig, DEFAULT_GENERATION, DEFAULT_MAP, DEFAULT_EXTRAS, DEFAULT_DOCTOR } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { scaffoldProject } from '../core/generator/project-scaffolder.js';
import { resolveDependencies, getVersion } from '../core/generator/deps.js';
import { HistoryManager } from '../core/history/index.js';
import { logger, withSpinner, SUPPORTED_STACKS } from '../utils/index.js';
import {
  SUPPORTED_CATEGORIES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_DATABASES,
  SUPPORTED_ORMS,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PACKAGE_MANAGERS,
  SUPPORTED_TEST_FRAMEWORKS,
} from '../utils/constants.js';
import type { FileOperation } from '../core/history/types.js';
import type { Category, Stack } from '../utils/constants.js';
import { PillarError } from '../utils/errors.js';

interface InitOptions {
  yes?: boolean;
  stack?: string;
  category?: string;
  language?: string;
  database?: string;
  orm?: string;
  architecture?: string;
  packageManager?: string;
  testFramework?: string;
  extras?: string;
  skipInstall?: boolean;
  skipGit?: boolean;
}

const allStacks = ['express', 'fastify', 'nestjs', 'hono', 'nextjs'] as const;

export async function initCommand(projectName: string | undefined, options: InitOptions): Promise<void> {
  logger.banner('Pillar — Project Initialization');

  // Non-interactive mode is triggered by -y OR by passing any flag override.
  const hasOverrides = Boolean(
    options.stack ?? options.category ?? options.language ?? options.database ??
      options.orm ?? options.architecture ?? options.packageManager ??
      options.testFramework ?? options.extras,
  );
  const nonInteractive = Boolean(options.yes) || hasOverrides;

  const answers = nonInteractive
    ? applyOverrides(getDefaultAnswers(projectName ?? 'my-app'), options)
    : await promptUser(projectName);
  const projectDir = path.resolve(answers.projectName);

  // Check if directory exists and has content
  if (await fs.pathExists(projectDir)) {
    const contents = await fs.readdir(projectDir);
    if (contents.length > 0) {
      const { proceed } = await inquirer.prompt<{ proceed: boolean }>([{
        type: 'confirm',
        name: 'proceed',
        message: `Directory "${answers.projectName}" is not empty. Continue?`,
        default: false,
      }]);
      if (!proceed) {
        logger.info('Aborted.');
        return;
      }
    }
  }

  await fs.ensureDir(projectDir);

  const config = buildConfig(answers);

  // 1. Write config
  await withSpinner('Writing configuration', async () => {
    await writeConfig(projectDir, config);
  });

  // 2. Scaffold project structure
  const { files, mapStructure } = scaffoldProject(config);
  const operations: FileOperation[] = [];

  await withSpinner(`Generating ${files.length} files`, async () => {
    for (const file of files) {
      const fullPath = path.join(projectDir, file.relativePath);
      await fs.ensureDir(path.dirname(fullPath));
      await fs.writeFile(fullPath, file.content, 'utf-8');
      operations.push({ type: 'create', path: file.relativePath });
    }
  });

  // 3. Generate project map
  await withSpinner('Generating project map', async () => {
    const mapManager = new MapManager(projectDir);
    await mapManager.initialize(config, mapStructure);
  });

  // 4. Generate package.json for the new project
  await withSpinner('Creating package.json', async () => {
    const deps = resolveDependencies(config);
    const pkg = buildPackageJson(config, deps);
    await fs.writeJson(path.join(projectDir, 'package.json'), pkg, { spaces: 2 });
  });

  // 5. Generate tsconfig if TypeScript
  if (config.project.language === 'typescript') {
    await withSpinner('Creating tsconfig.json', async () => {
      const tsconfig = buildTsConfig(config);
      await fs.writeJson(path.join(projectDir, 'tsconfig.json'), tsconfig, { spaces: 2 });
    });
  }

  // 6. Generate .gitignore
  await withSpinner('Creating .gitignore', async () => {
    const gitignore = [
      'node_modules/',
      'dist/',
      '.env',
      '*.tsbuildinfo',
      '.DS_Store',
      'coverage/',
      '',
    ].join('\n');
    await fs.writeFile(path.join(projectDir, '.gitignore'), gitignore);
  });

  // 7. Install dependencies (skippable for CI / E2E harnesses that assemble
  //    node_modules differently to avoid per-stack install cost).
  const pm = config.project.packageManager;
  const installCmd = pm === 'yarn' ? 'yarn' : `${pm} install`;

  if (!options.skipInstall) {
    await withSpinner(`Installing dependencies (${pm})`, async (spinner) => {
      const { execSync } = await import('node:child_process');
      try {
        execSync(installCmd, { cwd: projectDir, stdio: 'pipe', timeout: 300_000 });
      } catch (error) {
        spinner.warn(`Dependency installation failed — run "${installCmd}" manually`);
      }
    });
  }

  // 8. Init git
  if (!options.skipGit) {
    await withSpinner('Initializing git repository', async (spinner) => {
      const { execSync } = await import('node:child_process');
      try {
        execSync('git init', { cwd: projectDir, stdio: 'pipe' });
      } catch {
        spinner.warn('Git initialization failed — install git or run "git init" manually');
      }
    });
  }

  // 9. Record history
  const historyManager = new HistoryManager(projectDir);
  await historyManager.record(`init ${answers.projectName}`, operations);

  // Done
  logger.blank();
  logger.success(`${answers.projectName} is ready!`);
  logger.blank();
  logger.info('Next steps:');
  logger.list([
    `cd ${answers.projectName}`,
    `${pm === 'npm' ? 'npm run' : pm} dev`,
    'pillar add resource <name>   — generate a new feature',
    'pillar create <file> -p "…"  — create a file with purpose',
    'pillar doctor                — check project health',
  ]);
  logger.blank();
}

interface UserAnswers {
  projectName: string;
  platform: string;
  category: Category;
  stack: Stack;
  language: string;
  database: string;
  orm: string;
  architecture: string;
  packageManager: string;
  extras: string[];
  testFramework: string;
}

/**
 * Apply CLI flag overrides onto the default answer set. Every value is
 * validated against the supported-values lists so that a typo fails fast with
 * a helpful message rather than producing a bad `pillar.config.json` that
 * zod then rejects further down the pipeline.
 */
function applyOverrides(base: UserAnswers, options: InitOptions): UserAnswers {
  const out: UserAnswers = { ...base };

  if (options.category !== undefined) {
    assertOneOf('--category', options.category, SUPPORTED_CATEGORIES);
    out.category = options.category as Category;
  }
  if (options.stack !== undefined) {
    assertOneOf('--stack', options.stack, allStacks);
    out.stack = options.stack as Stack;
    // Keep category aligned with the stack so downstream scaffolding picks
    // the right templates for fullstack vs api.
    if (options.category === undefined) {
      out.category = (SUPPORTED_STACKS.fullstack as readonly string[]).includes(options.stack)
        ? 'fullstack'
        : 'api';
    }
  }
  if (options.language !== undefined) {
    assertOneOf('--language', options.language, SUPPORTED_LANGUAGES);
    out.language = options.language;
  }
  if (options.database !== undefined) {
    assertOneOf('--database', options.database, SUPPORTED_DATABASES);
    out.database = options.database;
  }
  if (options.orm !== undefined) {
    assertOneOf('--orm', options.orm, SUPPORTED_ORMS);
    out.orm = options.orm;
  }
  if (options.architecture !== undefined) {
    assertOneOf('--architecture', options.architecture, SUPPORTED_ARCHITECTURES);
    out.architecture = options.architecture;
  }
  if (options.packageManager !== undefined) {
    assertOneOf('--package-manager', options.packageManager, SUPPORTED_PACKAGE_MANAGERS);
    out.packageManager = options.packageManager;
  }
  if (options.testFramework !== undefined) {
    assertOneOf('--test-framework', options.testFramework, SUPPORTED_TEST_FRAMEWORKS);
    out.testFramework = options.testFramework;
  }
  if (options.extras !== undefined) {
    const allowed = new Set(['docker', 'linting', 'gitHooks']);
    out.extras = options.extras
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const e of out.extras) {
      if (!allowed.has(e)) {
        throw new PillarError(
          `Invalid --extras entry: "${e}"`,
          'INVALID_OPTION',
          `Allowed values: ${[...allowed].join(', ')}`,
        );
      }
    }
  }

  return out;
}

function assertOneOf(flag: string, value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) {
    throw new PillarError(
      `Invalid value for ${flag}: "${value}"`,
      'INVALID_OPTION',
      `Allowed values: ${allowed.join(', ')}`,
    );
  }
}

function getDefaultAnswers(projectName: string): UserAnswers {
  return {
    projectName,
    platform: 'web',
    category: 'api' as Category,
    stack: 'express' as Stack,
    language: 'typescript',
    database: 'none',
    orm: 'none',
    architecture: 'feature-first',
    packageManager: 'npm',
    extras: [],
    testFramework: 'vitest',
  };
}

async function promptUser(projectName?: string): Promise<UserAnswers> {
  const questions = [
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: projectName ?? 'my-app',
      when: () => !projectName,
      validate: (input: string) => {
        if (!/^[a-zA-Z0-9_-]+$/.test(input)) {
          return 'Project name can only contain letters, numbers, hyphens, and underscores';
        }
        return true;
      },
    },
    {
      type: 'list',
      name: 'platform',
      message: 'Platform:',
      choices: [
        { name: 'Web', value: 'web' },
        { name: 'Mobile (coming soon)', value: 'mobile', disabled: true },
        { name: 'Desktop (coming soon)', value: 'desktop', disabled: true },
        { name: 'CLI (coming soon)', value: 'cli', disabled: true },
      ],
    },
    {
      type: 'list',
      name: 'category',
      message: 'Category:',
      choices: [
        { name: 'API (backend only)', value: 'api' },
        { name: 'Fullstack', value: 'fullstack' },
      ],
    },
    {
      type: 'list',
      name: 'stack',
      message: 'Stack:',
      choices: (answers: UserAnswers) => {
        const stacks = SUPPORTED_STACKS[answers.category] ?? [];
        return stacks.map((s) => ({
          name: s.charAt(0).toUpperCase() + s.slice(1),
          value: s,
        }));
      },
    },
    {
      type: 'list',
      name: 'language',
      message: 'Language:',
      choices: [
        { name: 'TypeScript (recommended)', value: 'typescript' },
        { name: 'JavaScript', value: 'javascript' },
      ],
    },
    {
      type: 'list',
      name: 'database',
      message: 'Database:',
      choices: [
        { name: 'PostgreSQL', value: 'postgresql' },
        { name: 'MongoDB', value: 'mongodb' },
        { name: 'SQLite', value: 'sqlite' },
        { name: 'None', value: 'none' },
      ],
    },
    {
      type: 'list',
      name: 'orm',
      message: 'ORM:',
      when: (answers: UserAnswers) => answers.database !== 'none',
      choices: (answers: UserAnswers) => {
        const choices = [{ name: 'None (raw driver)', value: 'none' }];
        if (answers.database === 'mongodb') {
          choices.unshift({ name: 'Mongoose', value: 'mongoose' });
        }
        choices.unshift({ name: 'Drizzle', value: 'drizzle' });
        choices.unshift({ name: 'TypeORM', value: 'typeorm' });
        choices.unshift({ name: 'Prisma (recommended)', value: 'prisma' });
        return choices;
      },
    },
    {
      type: 'list',
      name: 'architecture',
      message: 'Architecture:',
      choices: [
        { name: 'Feature-first (recommended)', value: 'feature-first' },
        { name: 'Layered (MVC-style)', value: 'layered' },
        { name: 'Modular', value: 'modular' },
      ],
    },
    {
      type: 'list',
      name: 'packageManager',
      message: 'Package manager:',
      choices: [
        { name: 'npm', value: 'npm' },
        { name: 'yarn', value: 'yarn' },
        { name: 'pnpm', value: 'pnpm' },
      ],
    },
    {
      type: 'list',
      name: 'testFramework',
      message: 'Test framework:',
      choices: [
        { name: 'Vitest (recommended)', value: 'vitest' },
        { name: 'Jest', value: 'jest' },
      ],
    },
    {
      type: 'checkbox',
      name: 'extras',
      message: 'Extras:',
      choices: [
        { name: 'Docker', value: 'docker' },
        { name: 'ESLint + Prettier', value: 'linting' },
        { name: 'Git hooks (Husky)', value: 'gitHooks' },
      ],
    },
  ] as Parameters<typeof inquirer.prompt>[0];

  const answers = await inquirer.prompt<UserAnswers>(questions);

  // Fill defaults
  if (projectName) answers.projectName = projectName;
  if (!answers.orm) answers.orm = 'none';
  if (!answers.extras) answers.extras = [];

  return answers;
}

function buildConfig(answers: UserAnswers): PillarConfig {
  return {
    project: {
      name: answers.projectName,
      platform: 'web',
      category: answers.category,
      stack: answers.stack,
      language: answers.language as PillarConfig['project']['language'],
      architecture: answers.architecture as PillarConfig['project']['architecture'],
      packageManager: answers.packageManager as PillarConfig['project']['packageManager'],
    },
    database: {
      type: answers.database as PillarConfig['database']['type'],
      orm: answers.orm as PillarConfig['database']['orm'],
    },
    generation: {
      ...DEFAULT_GENERATION,
      testFramework: answers.testFramework as PillarConfig['generation']['testFramework'],
    },
    map: { ...DEFAULT_MAP },
    extras: {
      docker: answers.extras.includes('docker'),
      linting: answers.extras.includes('linting'),
      gitHooks: answers.extras.includes('gitHooks'),
    },
    doctor: { ...DEFAULT_DOCTOR },
  };
}

function buildPackageJson(
  config: PillarConfig,
  deps: { dependencies: string[]; devDependencies: string[] },
): Record<string, unknown> {
  const isTS = config.project.language === 'typescript';
  const scripts: Record<string, string> = {};

  switch (config.project.stack) {
    case 'express':
    case 'fastify':
    case 'hono':
      scripts['dev'] = isTS ? 'tsx watch src/server.ts' : 'node --watch src/server.js';
      scripts['build'] = isTS ? 'tsc' : 'echo "No build step"';
      scripts['start'] = isTS ? 'node dist/server.js' : 'node src/server.js';
      break;
    case 'nestjs':
      scripts['dev'] = 'nest start --watch';
      scripts['build'] = 'nest build';
      scripts['start'] = 'node dist/main.js';
      break;
    case 'nextjs':
      scripts['dev'] = 'next dev';
      scripts['build'] = 'next build';
      scripts['start'] = 'next start';
      break;
  }

  switch (config.generation.testFramework) {
    case 'vitest':
      scripts['test'] = 'vitest run';
      scripts['test:watch'] = 'vitest';
      break;
    case 'jest':
      scripts['test'] = 'jest';
      scripts['test:watch'] = 'jest --watch';
      break;
  }

  if (config.extras.linting) {
    scripts['lint'] = 'eslint src/';
    scripts['format'] = 'prettier --write src/';
  }

  const pkg: Record<string, unknown> = {
    name: config.project.name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts,
    dependencies: Object.fromEntries(deps.dependencies.map((d) => [d, getVersion(d)])),
    devDependencies: Object.fromEntries(deps.devDependencies.map((d) => [d, getVersion(d)])),
  };

  return pkg;
}

function buildTsConfig(config: PillarConfig): Record<string, unknown> {
  const base = {
    compilerOptions: {
      target: 'ES2022',
      module: 'Node16',
      moduleResolution: 'Node16',
      lib: ['ES2022'],
      outDir: './dist',
      rootDir: './src',
      declaration: true,
      sourceMap: true,
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      isolatedModules: true,
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist'],
  };

  // NestJS needs decorators
  if (config.project.stack === 'nestjs') {
    (base.compilerOptions as Record<string, unknown>)['experimentalDecorators'] = true;
    (base.compilerOptions as Record<string, unknown>)['emitDecoratorMetadata'] = true;
  }

  // Next.js has different tsconfig requirements
  if (config.project.stack === 'nextjs') {
    return {
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'preserve',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./src/*'] },
      },
      include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
      exclude: ['node_modules'],
    };
  }

  return base;
}
