import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { generateSeedFile, generateSeedRunner } from './seed-generator.js';
import type { PillarConfig } from '../config/index.js';

function makeConfig(overrides: Partial<PillarConfig['project']> = {}): PillarConfig {
  return {
    project: {
      name: 'test-app',
      platform: 'web',
      category: 'api',
      stack: 'express',
      language: 'typescript',
      architecture: 'feature-first',
      packageManager: 'npm',
      ...overrides,
    },
    database: { type: 'postgresql', orm: 'prisma' },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: true, format: ['json', 'markdown'] },
    extras: { docker: false, linting: false, gitHooks: false },
  };
}

describe('generateSeedFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-seed-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('generates a seed file with correct path', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig(), 'user', 10);
    expect(result.relativePath).toBe('src/seeds/user.seed.ts');
    expect(result.purpose).toContain('user');
    expect(result.purpose).toContain('10');
  });

  it('generates JS extension for JavaScript projects', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig({ language: 'javascript' }), 'user', 5);
    expect(result.relativePath).toBe('src/seeds/user.seed.js');
  });

  it('includes seeded PRNG helpers', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig(), 'user', 20);
    expect(result.content).toContain('function rand()');
    expect(result.content).toContain('function randInt');
    expect(result.content).toContain('function randItem');
  });

  it('generates TypeScript typed helpers for TS projects', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig(), 'user', 5);
    expect(result.content).toContain('min: number, max: number');
    expect(result.content).toContain('randItem<T>');
  });

  it('generates untyped helpers for JS projects', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig({ language: 'javascript' }), 'user', 5);
    expect(result.content).toContain('function randInt(min, max)');
    expect(result.content).toContain('function randItem(arr)');
    expect(result.content).not.toContain('min: number');
    expect(result.content).not.toContain('<T>');
  });

  it('includes export seed function', async () => {
    const result = await generateSeedFile(tmpDir, makeConfig(), 'user', 10);
    expect(result.content).toContain('export async function seed()');
    expect(result.content).toContain('Array.from({ length: 10 }');
  });

  it('reads fields from existing types file', async () => {
    // Create a types file for the seed generator to discover
    const typesDir = path.join(tmpDir, 'src/features/user');
    await fs.ensureDir(typesDir);
    await fs.writeFile(
      path.join(typesDir, 'user.types.ts'),
      `export interface User {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  email: string;
  name: string;
  age: number;
}`,
      'utf-8',
    );

    const result = await generateSeedFile(tmpDir, makeConfig(), 'user', 5);
    // Should have smart generators for email, name, age
    expect(result.content).toContain('email');
    expect(result.content).toContain('@example.com');
    expect(result.content).toContain('FIRST_NAMES');
    expect(result.content).toContain('randInt(18, 80)');
  });
});

describe('generateSeedRunner', () => {
  it('generates a runner that imports all seeds', () => {
    const config = makeConfig();
    const result = generateSeedRunner(config, ['user.seed.ts', 'product.seed.ts']);

    expect(result.relativePath).toBe('src/seeds/run.ts');
    expect(result.content).toContain("import { seed as seedUser } from './user.seed.js'");
    expect(result.content).toContain("import { seed as seedProduct } from './product.seed.js'");
    expect(result.content).toContain('await seedUser()');
    expect(result.content).toContain('await seedProduct()');
  });

  it('generates JS runner for JavaScript projects', () => {
    const config = makeConfig({ language: 'javascript' });
    const result = generateSeedRunner(config, ['user.seed.js']);
    expect(result.relativePath).toBe('src/seeds/run.js');
  });

  it('includes error handling', () => {
    const config = makeConfig();
    const result = generateSeedRunner(config, ['user.seed.ts']);
    expect(result.content).toContain('.catch');
    expect(result.content).toContain('process.exit(1)');
  });
});
