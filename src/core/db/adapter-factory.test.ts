import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import { selectAdapter } from './adapter-factory.js';
import { isUnsupported } from './types.js';
import type { RunContext } from './types.js';

function mkConfig(orm: PillarConfig['database']['orm']): PillarConfig {
  return {
    project: {
      name: 't', platform: 'web', category: 'api',
      stack: 'express', language: 'typescript', architecture: 'feature-first',
      packageManager: 'npm',
    },
    database: { type: 'postgresql', orm },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: true, format: ['json'] },
    extras: { docker: false, linting: false, gitHooks: false },
    doctor: { tscTimeoutMs: 60_000 },
  } as PillarConfig;
}

const CTX: RunContext = { projectRoot: '/tmp/x', packageManager: 'npm' };

describe('selectAdapter', () => {
  it.each(['prisma', 'drizzle', 'typeorm', 'mongoose', 'none'] as const)(
    'returns an adapter with matching orm for %s',
    (orm) => {
      const adapter = selectAdapter(mkConfig(orm));
      expect(adapter.orm).toBe(orm);
    },
  );

  it('prisma planMigrate requires a name', () => {
    const adapter = selectAdapter(mkConfig('prisma'));
    const plan = adapter.planMigrate({}, CTX);
    expect(isUnsupported(plan)).toBe(true);
  });

  it('prisma planMigrate with name builds prisma migrate dev argv', () => {
    const adapter = selectAdapter(mkConfig('prisma'));
    const plan = adapter.planMigrate({ name: 'add_role' }, CTX);
    if (isUnsupported(plan)) throw new Error('expected a runnable plan');
    expect(plan.argv.slice(1)).toContain('migrate');
    expect(plan.argv).toContain('add_role');
    expect(plan.destructive).toBe(true);
    expect(plan.applies).toBe(true);
  });

  it('prisma planDeploy is non-interactive and applies', () => {
    const adapter = selectAdapter(mkConfig('prisma'));
    const plan = adapter.planDeploy(CTX);
    if (isUnsupported(plan)) throw new Error('expected a runnable plan');
    expect(plan.argv).toContain('deploy');
    expect(plan.applies).toBe(true);
  });

  it('prisma planRollback is unsupported with a hint', () => {
    const adapter = selectAdapter(mkConfig('prisma'));
    const plan = adapter.planRollback(CTX);
    expect(isUnsupported(plan)).toBe(true);
    if (!isUnsupported(plan)) return;
    expect(plan.hint).toBeDefined();
  });

  it('drizzle migrate and deploy produce the same command', () => {
    const adapter = selectAdapter(mkConfig('drizzle'));
    const m = adapter.planMigrate({}, CTX);
    const d = adapter.planDeploy(CTX);
    if (isUnsupported(m) || isUnsupported(d)) throw new Error('expected runnable plans');
    expect(m.argv).toEqual(d.argv);
  });

  it('typeorm planGenerate requires a name', () => {
    const adapter = selectAdapter(mkConfig('typeorm'));
    expect(isUnsupported(adapter.planGenerate({}, CTX))).toBe(true);
  });

  it('typeorm planGenerate includes migration name in argv', () => {
    const adapter = selectAdapter(mkConfig('typeorm'));
    const plan = adapter.planGenerate({ name: 'AddUserRole' }, CTX);
    if (isUnsupported(plan)) throw new Error('expected a runnable plan');
    expect(plan.argv.join(' ')).toContain('AddUserRole');
  });

  it('mongoose is unsupported everywhere with helpful hints', () => {
    const adapter = selectAdapter(mkConfig('mongoose'));
    for (const r of [
      adapter.planGenerate({}, CTX),
      adapter.planMigrate({}, CTX),
      adapter.planDeploy(CTX),
      adapter.planStatus(CTX),
      adapter.planReset(CTX),
      adapter.planRollback(CTX),
    ]) {
      expect(isUnsupported(r)).toBe(true);
    }
  });

  it('none is unsupported and hints at config', () => {
    const adapter = selectAdapter(mkConfig('none'));
    const r = adapter.planMigrate({}, CTX);
    expect(isUnsupported(r)).toBe(true);
    if (!isUnsupported(r)) return;
    expect(r.hint).toMatch(/pillar\.config\.json/);
  });

  it('package manager selection flows into argv (yarn)', () => {
    const config = { ...mkConfig('prisma') };
    const adapter = selectAdapter(config);
    const plan = adapter.planMigrate({ name: 'x' }, { ...CTX, packageManager: 'yarn' });
    if (isUnsupported(plan)) throw new Error('expected a runnable plan');
    expect(plan.argv[0]).toBe('yarn');
  });

  it('package manager selection flows into argv (pnpm)', () => {
    const adapter = selectAdapter(mkConfig('prisma'));
    const plan = adapter.planMigrate({ name: 'x' }, { ...CTX, packageManager: 'pnpm' });
    if (isUnsupported(plan)) throw new Error('expected a runnable plan');
    expect(plan.argv[0]).toBe('pnpm');
    expect(plan.argv[1]).toBe('exec');
  });
});

describe('adapter previewSql — Drizzle', () => {
  let root: string;

  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-drizzle-')); });
  afterEach(async () => {
    delete process.env['PILLAR_DRIZZLE_OUT'];
    await fs.remove(root);
  });

  it('returns null when no drizzle out dir exists', async () => {
    const adapter = selectAdapter(mkConfig('drizzle'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toBeNull();
  });

  it('reads SQL files from the default drizzle/ out dir', async () => {
    await fs.ensureDir(path.join(root, 'drizzle'));
    await fs.writeFile(path.join(root, 'drizzle', '0000_init.sql'), 'CREATE TABLE users (id serial);');
    const adapter = selectAdapter(mkConfig('drizzle'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toContain('0000_init.sql');
    expect(sql).toContain('CREATE TABLE users');
  });

  it('honors PILLAR_DRIZZLE_OUT override', async () => {
    const custom = path.join(root, 'custom-migrations');
    await fs.ensureDir(custom);
    await fs.writeFile(path.join(custom, '0000_hello.sql'), 'SELECT 1;');
    process.env['PILLAR_DRIZZLE_OUT'] = custom;
    const adapter = selectAdapter(mkConfig('drizzle'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toContain('0000_hello.sql');
  });
});

describe('adapter previewSql — TypeORM', () => {
  let root: string;

  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-typeorm-')); });
  afterEach(async () => {
    delete process.env['PILLAR_TYPEORM_MIGRATIONS'];
    await fs.remove(root);
  });

  it('returns null when src/migrations does not exist', async () => {
    const adapter = selectAdapter(mkConfig('typeorm'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toBeNull();
  });

  it('reads .ts and .js migration files from src/migrations', async () => {
    const dir = path.join(root, 'src', 'migrations');
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, '1700000000000-AddUser.ts'), 'export class AddUser {}');
    const adapter = selectAdapter(mkConfig('typeorm'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toContain('1700000000000-AddUser.ts');
    expect(sql).toContain('export class AddUser');
  });

  it('honors PILLAR_TYPEORM_MIGRATIONS override', async () => {
    const custom = path.join(root, 'db', 'migrations');
    await fs.ensureDir(custom);
    await fs.writeFile(path.join(custom, '001-init.ts'), 'export class Init {}');
    process.env['PILLAR_TYPEORM_MIGRATIONS'] = custom;
    const adapter = selectAdapter(mkConfig('typeorm'));
    const sql = await adapter.previewSql!({}, { ...CTX, projectRoot: root });
    expect(sql).toContain('001-init.ts');
  });
});
