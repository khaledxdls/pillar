import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import { runStatus } from './status.js';

/**
 * Status tests are integration-shaped: each scenario writes a small
 * fixture (config, map, env, migrations) into a temp dir and asserts
 * on the resulting `StatusReport`. We deliberately don't mock the
 * underlying managers — composing real modules is the whole point of
 * `pillar status`, and exercising them at integration level is what
 * catches breakage when one of them changes shape.
 */

function mkConfig(overrides: Partial<PillarConfig['database']> = {}): PillarConfig {
  return {
    project: {
      name: 'st', platform: 'web', category: 'api',
      stack: 'express', language: 'typescript',
      architecture: 'feature-first', packageManager: 'npm',
    },
    database: { type: 'postgresql', orm: 'prisma', ...overrides } as PillarConfig['database'],
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: true, format: ['json'] },
    extras: { docker: false, linting: false, gitHooks: false },
    doctor: { tscTimeoutMs: 60_000 },
  } as PillarConfig;
}

async function writeMap(root: string, structure: Record<string, unknown> = {}): Promise<void> {
  await fs.ensureDir(path.join(root, '.pillar'));
  await fs.writeJson(path.join(root, '.pillar', 'map.json'), {
    meta: { name: 'st', version: '1', generatedAt: new Date().toISOString() },
    structure,
  });
}

describe('runStatus', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-status-'));
  });
  afterEach(async () => { await fs.remove(root); });

  it('reports fail when no map exists', async () => {
    const report = await runStatus(root, mkConfig());
    const map = report.sections.find((s) => s.name === 'Map');
    expect(map?.level).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('reports ok map when validation finds no drift', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig());
    const map = report.sections.find((s) => s.name === 'Map');
    expect(map?.level).toBe('ok');
    expect(map?.summary).toBe('in sync');
  });

  it('exposes project metadata accurately', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig());
    expect(report.project.name).toBe('st');
    expect(report.project.stack).toBe('express');
    expect(report.project.orm).toBe('prisma');
  });

  it('env section is ok when no .env.example exists', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig());
    const env = report.sections.find((s) => s.name === 'Env');
    expect(env?.level).toBe('ok');
    expect(env?.summary).toMatch(/no \.env\.example/);
  });

  it('env section is fail when required keys are empty', async () => {
    await writeMap(root, {});
    await fs.writeFile(path.join(root, '.env.example'), 'DATABASE_URL=postgres://example\nAPI_KEY=\n');
    await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=\nAPI_KEY=\n');
    const report = await runStatus(root, mkConfig());
    const env = report.sections.find((s) => s.name === 'Env');
    expect(env?.level).toBe('fail');
    expect(report.overall).toBe('fail');
  });

  it('migrations section: prisma counts timestamped subdirs', async () => {
    await writeMap(root, {});
    const dir = path.join(root, 'prisma', 'migrations');
    await fs.ensureDir(path.join(dir, '20240101120000_init'));
    await fs.ensureDir(path.join(dir, '20240201090000_add_role'));
    const report = await runStatus(root, mkConfig({ orm: 'prisma' }));
    const m = report.sections.find((s) => s.name === 'Migrations');
    expect(m?.level).toBe('ok');
    expect(m?.summary).toMatch(/2 prisma migration/);
  });

  it('migrations section: drizzle counts .sql files', async () => {
    await writeMap(root, {});
    await fs.ensureDir(path.join(root, 'drizzle'));
    await fs.writeFile(path.join(root, 'drizzle', '0000_init.sql'), '');
    await fs.writeFile(path.join(root, 'drizzle', 'README.md'), '');
    const report = await runStatus(root, mkConfig({ orm: 'drizzle' }));
    const m = report.sections.find((s) => s.name === 'Migrations');
    expect(m?.summary).toMatch(/1 drizzle migration/);
  });

  it('migrations section: warn when ORM expected but no dir', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig({ orm: 'typeorm' }));
    const m = report.sections.find((s) => s.name === 'Migrations');
    expect(m?.level).toBe('warn');
    expect(m?.summary).toMatch(/no migrations directory/);
  });

  it('migrations section: ok skip for mongoose / none', async () => {
    await writeMap(root, {});
    const r1 = await runStatus(root, mkConfig({ orm: 'mongoose' }));
    expect(r1.sections.find((s) => s.name === 'Migrations')?.level).toBe('ok');
    const r2 = await runStatus(root, mkConfig({ orm: 'none' }));
    expect(r2.sections.find((s) => s.name === 'Migrations')?.level).toBe('ok');
  });

  it('history section: ok with no operations', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig());
    const h = report.sections.find((s) => s.name === 'History');
    expect(h?.level).toBe('ok');
    expect(h?.summary).toMatch(/no operations/);
  });

  it('history section: surfaces last command and humanized time', async () => {
    await writeMap(root, {});
    await fs.ensureDir(path.join(root, '.pillar'));
    await fs.writeJson(path.join(root, '.pillar', 'history.json'), {
      entries: [
        {
          id: '1',
          timestamp: new Date(Date.now() - 5_000).toISOString(),
          command: 'add resource user',
          operations: [],
        },
      ],
    });
    const report = await runStatus(root, mkConfig());
    const h = report.sections.find((s) => s.name === 'History');
    expect(h?.summary).toMatch(/last op/);
    expect(h?.details?.[0]).toContain('add resource user');
  });

  it('plugins section: counts configured specifiers', async () => {
    await writeMap(root, {});
    const cfg = mkConfig();
    cfg.plugins = ['plugin-a', './plugin-b'];
    const report = await runStatus(root, cfg);
    const p = report.sections.find((s) => s.name === 'Plugins');
    expect(p?.summary).toMatch(/2 configured/);
    expect(p?.details).toEqual(['plugin-a', './plugin-b']);
  });

  it('aggregate is fail when any section fails', async () => {
    // No map → Map is fail → overall is fail regardless of others
    const report = await runStatus(root, mkConfig());
    expect(report.overall).toBe('fail');
  });

  it('aggregate is warn when warn but no fail', async () => {
    await writeMap(root, {});
    // typeorm with no migrations dir → warn; everything else ok
    const report = await runStatus(root, mkConfig({ orm: 'typeorm' }));
    expect(report.overall).toBe('warn');
  });

  it('aggregate is ok when everything passes', async () => {
    await writeMap(root, {});
    const report = await runStatus(root, mkConfig({ orm: 'mongoose' }));
    expect(report.overall).toBe('ok');
  });
});
