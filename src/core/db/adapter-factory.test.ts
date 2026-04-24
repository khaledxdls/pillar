import { describe, it, expect } from 'vitest';
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
