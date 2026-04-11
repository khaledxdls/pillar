import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';

interface LintingFile {
  relativePath: string;
  content: string;
}

/**
 * Generate all linting/formatting config files based on the project config.
 */
export function generateLintingFiles(config: PillarConfig): LintingFile[] {
  const files: LintingFile[] = [];
  const isTS = config.project.language === 'typescript';

  files.push({
    relativePath: 'eslint.config.mjs',
    content: generateFlatESLintConfig(config, isTS),
  });

  files.push({
    relativePath: '.prettierrc',
    content: JSON.stringify(
      {
        semi: true,
        singleQuote: true,
        trailingComma: 'all',
        printWidth: 100,
        tabWidth: 2,
      },
      null,
      2,
    ) + '\n',
  });

  files.push({
    relativePath: '.prettierignore',
    content: ['dist/', 'node_modules/', 'coverage/', '.next/', '*.json', ''].join('\n'),
  });

  return files;
}

/**
 * Generate git hooks config files (Husky + lint-staged).
 */
export function generateGitHooksFiles(config: PillarConfig): LintingFile[] {
  const files: LintingFile[] = [];
  const isTS = config.project.language === 'typescript';
  const ext = isTS ? 'ts' : 'js';

  files.push({
    relativePath: '.lintstagedrc.json',
    content: JSON.stringify(
      {
        [`*.{${ext},${ext}x}`]: ['eslint --fix', 'prettier --write'],
        '*.{json,md,yml,yaml}': ['prettier --write'],
      },
      null,
      2,
    ) + '\n',
  });

  files.push({
    relativePath: '.husky/pre-commit',
    content: 'npx lint-staged\n',
  });

  return files;
}

/**
 * Resolve the npm packages needed for linting/formatting.
 */
export function resolveLintingDeps(config: PillarConfig): { deps: string[]; devDeps: string[] } {
  const devDeps: string[] = ['eslint', 'prettier', 'eslint-config-prettier'];
  const isTS = config.project.language === 'typescript';

  if (isTS) {
    devDeps.push('typescript-eslint');
  }

  return { deps: [], devDeps };
}

/**
 * Resolve the npm packages needed for git hooks.
 */
export function resolveGitHooksDeps(): { deps: string[]; devDeps: string[] } {
  return { deps: [], devDeps: ['husky', 'lint-staged'] };
}

function generateFlatESLintConfig(config: PillarConfig, isTS: boolean): string {
  if (isTS) {
    return [
      `import eslint from '@eslint/js';`,
      `import tseslint from 'typescript-eslint';`,
      `import eslintConfigPrettier from 'eslint-config-prettier';`,
      '',
      'export default tseslint.config(',
      '  eslint.configs.recommended,',
      '  ...tseslint.configs.recommended,',
      '  eslintConfigPrettier,',
      '  {',
      '    ignores: ["dist/", "node_modules/", "coverage/"],',
      '  },',
      ');',
      '',
    ].join('\n');
  }

  return [
    `import eslint from '@eslint/js';`,
    `import eslintConfigPrettier from 'eslint-config-prettier';`,
    '',
    'export default [',
    '  eslint.configs.recommended,',
    '  eslintConfigPrettier,',
    '  {',
    '    ignores: ["dist/", "node_modules/", "coverage/"],',
    '  },',
    '];',
    '',
  ].join('\n');
}
