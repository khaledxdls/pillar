import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { dbSeedCommand } from './db.js';

/**
 * Integration tests for `pillar db seed`.
 *
 * We don't want to actually spawn `node` or `tsx` in unit tests, so the
 * tests exercise the planning/guard layer: preview mode prints the argv
 * and returns without executing; the production guard refuses to run
 * when `NODE_ENV=production`; missing runner emits a typed hint.
 */

describe('dbSeedCommand', () => {
  let root: string;
  let cwd: string;
  let logs: string[];
  let errors: string[];
  let origCwd: () => string;
  let origNodeEnv: string | undefined;
  let origExitCode: number | string | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-seed-cmd-'));
    cwd = root;
    logs = [];
    errors = [];
    origCwd = process.cwd;
    process.cwd = () => cwd;
    origNodeEnv = process.env['NODE_ENV'];
    origExitCode = process.exitCode;
    process.exitCode = 0;

    // Minimal Pillar project
    await fs.writeJson(path.join(root, 'pillar.config.json'), {
      project: {
        name: 'seedtest', platform: 'web', category: 'api',
        stack: 'express', language: 'typescript',
        architecture: 'feature-first', packageManager: 'npm',
      },
      database: { type: 'postgresql', orm: 'prisma' },
      generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
      map: { autoUpdate: false, format: ['json'] },
      extras: { docker: false, linting: false, gitHooks: false },
      doctor: { tscTimeoutMs: 60_000 },
    });

    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(args.join(' ')); });
    // logger uses process.stdout.write
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      errors.push(String(chunk));
      return true;
    });
  });

  afterEach(async () => {
    process.cwd = origCwd;
    if (origNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = origNodeEnv;
    process.exitCode = origExitCode as number;
    vi.restoreAllMocks();
    await fs.remove(root);
  });

  it('emits a helpful error when no seed runner exists', async () => {
    await dbSeedCommand({});
    expect(process.exitCode).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toMatch(/No seed runner/);
    expect(combined).toMatch(/pillar seed generate/);
  });

  it('preview mode prints argv and does not execute', async () => {
    await fs.ensureDir(path.join(root, 'src', 'seeds'));
    await fs.writeFile(path.join(root, 'src', 'seeds', 'run.ts'), '// runner');

    await dbSeedCommand({ preview: true });

    expect(process.exitCode).toBe(0);
    const combined = logs.join('\n');
    expect(combined).toMatch(/PREVIEW/);
    expect(combined).toMatch(/src\/seeds\/run\.ts/);
    expect(combined).toMatch(/Nothing was executed/);
  });

  it('refuses to run under NODE_ENV=production without --force-production', async () => {
    await fs.ensureDir(path.join(root, 'src', 'seeds'));
    await fs.writeFile(path.join(root, 'src', 'seeds', 'run.ts'), '// runner');
    process.env['NODE_ENV'] = 'production';

    await dbSeedCommand({});

    expect(process.exitCode).toBe(1);
    const combined = errors.join('\n');
    expect(combined).toMatch(/Refusing to run a destructive command/);
    expect(combined).toMatch(/seed runner/);
  });

  it('uses node + .js runner when language is javascript', async () => {
    // Flip to JS project
    const cfg = await fs.readJson(path.join(root, 'pillar.config.json'));
    cfg.project.language = 'javascript';
    await fs.writeJson(path.join(root, 'pillar.config.json'), cfg);

    await fs.ensureDir(path.join(root, 'src', 'seeds'));
    await fs.writeFile(path.join(root, 'src', 'seeds', 'run.js'), '// runner');

    await dbSeedCommand({ preview: true });

    expect(process.exitCode).toBe(0);
    const combined = logs.join('\n');
    expect(combined).toMatch(/node/);
    expect(combined).toMatch(/src\/seeds\/run\.js/);
  });

  it('emits not-in-project error outside a Pillar project', async () => {
    cwd = os.tmpdir();
    await dbSeedCommand({});
    expect(process.exitCode).toBe(1);
    expect(errors.join('\n')).toMatch(/Not inside a Pillar project/);
  });
});
