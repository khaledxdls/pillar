import type { PillarConfig } from '../config/index.js';

interface DependencySet {
  dependencies: string[];
  devDependencies: string[];
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
