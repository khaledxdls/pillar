import type { PillarConfig } from '../config/index.js';

interface DependencySet {
  dependencies: string[];
  devDependencies: string[];
}

/**
 * Known-good versions for generated projects.
 * Update these periodically to track stable releases.
 */
const VERSION_MAP: Record<string, string> = {
  // Frameworks
  'express': '^4.21.0',
  'cors': '^2.8.5',
  'fastify': '^5.2.0',
  '@fastify/cors': '^10.0.0',
  'hono': '^4.6.0',
  '@hono/node-server': '^1.13.0',
  '@nestjs/core': '^10.4.0',
  '@nestjs/common': '^10.4.0',
  '@nestjs/platform-express': '^10.4.0',
  'reflect-metadata': '^0.2.2',
  'rxjs': '^7.8.1',
  'next': '^14.2.0',
  'react': '^18.3.0',
  'react-dom': '^18.3.0',

  // TypeScript
  'typescript': '^5.6.0',
  'tsx': '^4.19.0',

  // ORMs / DB
  '@prisma/client': '^5.22.0',
  'prisma': '^5.22.0',
  'drizzle-orm': '^0.36.0',
  'drizzle-kit': '^0.28.0',
  'typeorm': '^0.3.20',
  'mongoose': '^8.8.0',
  'pg': '^8.13.0',
  'postgres': '^3.4.0',
  'mongodb': '^6.10.0',
  'better-sqlite3': '^11.6.0',

  // Testing
  'vitest': '^2.1.0',
  'jest': '^29.7.0',
  'ts-jest': '^29.2.0',

  // Linting
  'eslint': '^9.14.0',
  'prettier': '^3.4.0',
  'eslint-config-prettier': '^9.1.0',
  '@typescript-eslint/eslint-plugin': '^8.14.0',
  '@typescript-eslint/parser': '^8.14.0',

  // Git hooks
  'husky': '^9.1.0',
  'lint-staged': '^15.2.0',

  // Misc
  'dotenv': '^16.4.0',
  'zod': '^3.23.0',

  // Type definitions
  '@types/node': '^22.9.0',
  '@types/express': '^5.0.0',
  '@types/cors': '^2.8.17',
  '@types/react': '^18.3.0',
  '@types/react-dom': '^18.3.0',
  '@types/pg': '^8.11.0',
  '@types/better-sqlite3': '^7.6.0',
  '@types/jest': '^29.5.0',
  '@nestjs/cli': '^10.4.0',
  '@nestjs/testing': '^10.4.0',
};

/**
 * Get the pinned version for a package, falling back to 'latest'.
 */
export function getVersion(pkg: string): string {
  return VERSION_MAP[pkg] ?? 'latest';
}

/**
 * Determine all npm dependencies needed for the selected stack and options.
 */
export function resolveDependencies(config: PillarConfig): DependencySet {
  const deps: string[] = [];
  const devDeps: string[] = [];

  // Stack
  switch (config.project.stack) {
    case 'express':
      deps.push('express', 'cors');
      if (config.project.language === 'typescript') {
        devDeps.push('@types/express', '@types/cors');
      }
      break;
    case 'fastify':
      deps.push('fastify', '@fastify/cors');
      break;
    case 'hono':
      deps.push('hono', '@hono/node-server');
      break;
    case 'nestjs':
      deps.push(
        '@nestjs/core',
        '@nestjs/common',
        '@nestjs/platform-express',
        'reflect-metadata',
        'rxjs',
      );
      devDeps.push('@nestjs/cli', '@nestjs/testing');
      break;
    case 'nextjs':
      deps.push('next', 'react', 'react-dom');
      if (config.project.language === 'typescript') {
        devDeps.push('@types/react', '@types/react-dom');
      }
      break;
  }

  // TypeScript
  if (config.project.language === 'typescript') {
    devDeps.push('typescript', '@types/node');
    // tsx for dev server
    if (config.project.stack !== 'nextjs') {
      devDeps.push('tsx');
    }
  }

  // Database / ORM
  switch (config.database.orm) {
    case 'prisma':
      deps.push('@prisma/client');
      devDeps.push('prisma');
      break;
    case 'drizzle':
      deps.push('drizzle-orm');
      devDeps.push('drizzle-kit');
      if (config.database.type === 'postgresql') deps.push('postgres');
      if (config.database.type === 'sqlite') deps.push('better-sqlite3');
      if (config.database.type === 'mongodb') deps.push('mongodb');
      break;
    case 'typeorm':
      deps.push('typeorm');
      if (config.database.type === 'postgresql') deps.push('pg');
      if (config.database.type === 'mongodb') deps.push('mongodb');
      if (config.database.type === 'sqlite') deps.push('better-sqlite3');
      break;
    case 'mongoose':
      deps.push('mongoose');
      break;
  }

  // Database driver (if no ORM but database selected)
  if (config.database.orm === 'none' && config.database.type !== 'none') {
    switch (config.database.type) {
      case 'postgresql':
        deps.push('pg');
        if (config.project.language === 'typescript') devDeps.push('@types/pg');
        break;
      case 'mongodb':
        deps.push('mongodb');
        break;
      case 'sqlite':
        deps.push('better-sqlite3');
        if (config.project.language === 'typescript') devDeps.push('@types/better-sqlite3');
        break;
    }
  }

  // Extras
  if (config.extras.linting) {
    devDeps.push('eslint', 'prettier', 'eslint-config-prettier');
    if (config.project.language === 'typescript') {
      devDeps.push('@typescript-eslint/eslint-plugin', '@typescript-eslint/parser');
    }
  }

  if (config.extras.gitHooks) {
    devDeps.push('husky', 'lint-staged');
  }

  // Testing
  switch (config.generation.testFramework) {
    case 'vitest':
      devDeps.push('vitest');
      break;
    case 'jest':
      devDeps.push('jest');
      if (config.project.language === 'typescript') {
        devDeps.push('ts-jest', '@types/jest');
      }
      break;
  }

  // dotenv for non-Next.js projects
  if (config.project.stack !== 'nextjs') {
    deps.push('dotenv');
  }

  // Zod for validation (useful universally)
  deps.push('zod');

  return {
    dependencies: [...new Set(deps)].sort(),
    devDependencies: [...new Set(devDeps)].sort(),
  };
}
