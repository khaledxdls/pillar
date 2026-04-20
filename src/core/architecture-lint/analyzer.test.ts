import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { analyzeArchitecture } from './analyzer.js';
import type { PillarConfig } from '../config/index.js';

const baseConfig: PillarConfig = {
  project: {
    name: 'fixture',
    platform: 'web',
    category: 'api',
    stack: 'express',
    language: 'typescript',
    architecture: 'feature-first',
    packageManager: 'npm',
  },
  database: { type: 'postgresql', orm: 'none' },
  generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
  map: { autoUpdate: true, format: ['json', 'markdown'] },
  extras: { docker: false, linting: false, gitHooks: false },
  doctor: { tscTimeoutMs: 60_000 },
};

async function write(root: string, rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.ensureDir(path.dirname(abs));
  await fs.writeFile(abs, content, 'utf-8');
}

describe('analyzeArchitecture', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-arch-lint-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns an empty report when src/ does not exist', async () => {
    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations).toEqual([]);
    expect(report.filesScanned).toBe(0);
  });

  it('AL001: flags controller importing repository directly', async () => {
    await write(tmp, 'src/features/user/user.controller.ts',
      `import { UserRepository } from './user.repository.js';\nexport class UserController {}\n`);
    await write(tmp, 'src/features/user/user.repository.ts',
      `export class UserRepository {}\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations.some((v) => v.rule === 'AL001')).toBe(true);
  });

  it('AL002: flags repository importing service', async () => {
    await write(tmp, 'src/features/user/user.repository.ts',
      `import { UserService } from './user.service.js';\nexport class UserRepository {}\n`);
    await write(tmp, 'src/features/user/user.service.ts',
      `export class UserService {}\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations.some((v) => v.rule === 'AL002')).toBe(true);
  });

  it('AL003: flags cross-feature imports under feature-first', async () => {
    await write(tmp, 'src/features/orders/orders.service.ts',
      `import { UserService } from '../user/user.service.js';\nexport class OrdersService {}\n`);
    await write(tmp, 'src/features/user/user.service.ts',
      `export class UserService {}\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    const violation = report.violations.find((v) => v.rule === 'AL003');
    expect(violation).toBeDefined();
    expect(violation?.message).toMatch(/orders.*user/);
  });

  it('AL003: does not fire for layered architecture', async () => {
    await write(tmp, 'src/controllers/user.controller.ts',
      `import { UserService } from '../services/user.service.js';\nexport class UserController {}\n`);
    await write(tmp, 'src/services/user.service.ts',
      `export class UserService {}\n`);

    const report = await analyzeArchitecture(tmp, { ...baseConfig, project: { ...baseConfig.project, architecture: 'layered' } });
    expect(report.violations.some((v) => v.rule === 'AL003')).toBe(false);
  });

  it('AL005: flags DB driver imported from a service', async () => {
    await write(tmp, 'src/features/user/user.service.ts',
      `import { Pool } from 'pg';\nexport class UserService { pool = new Pool(); }\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    const violation = report.violations.find((v) => v.rule === 'AL005');
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('pg');
  });

  it('AL005: allows DB driver in repository files', async () => {
    await write(tmp, 'src/features/user/user.repository.ts',
      `import { Pool } from 'pg';\nexport class UserRepository { pool = new Pool(); }\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations.some((v) => v.rule === 'AL005')).toBe(false);
  });

  it('AL006: detects a two-file cycle', async () => {
    await write(tmp, 'src/features/a/a.service.ts',
      `import { B } from '../b/b.service.js';\nexport class A {}\n`);
    await write(tmp, 'src/features/b/b.service.ts',
      `import { A } from '../a/a.service.js';\nexport class B {}\n`);

    // Cross-feature imports will also trigger AL003; that's fine — the
    // test isolates AL006.
    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations.some((v) => v.rule === 'AL006')).toBe(true);
  });

  it('ignores test files so test fixtures can cross layers', async () => {
    await write(tmp, 'src/features/user/user.controller.test.ts',
      `import { UserRepository } from './user.repository.js';\ntest('x', () => {});\n`);
    await write(tmp, 'src/features/user/user.repository.ts',
      `export class UserRepository {}\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    expect(report.violations).toEqual([]);
  });

  it('reports line numbers on violations', async () => {
    await write(tmp, 'src/features/user/user.controller.ts',
      `// first line\nimport { UserRepository } from './user.repository.js';\nexport class C {}\n`);
    await write(tmp, 'src/features/user/user.repository.ts',
      `export class UserRepository {}\n`);

    const report = await analyzeArchitecture(tmp, baseConfig);
    const v = report.violations.find((x) => x.rule === 'AL001');
    expect(v?.line).toBe(2);
  });
});
