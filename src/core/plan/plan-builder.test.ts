import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { PlanBuilder } from './plan-builder.js';

describe('PlanBuilder', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-plan-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('records a create for a non-existent path', async () => {
    const b = new PlanBuilder(tmp, 'add resource user');
    await b.create('src/user.ts', 'export const x = 1;\n', 'user model');
    const plan = b.build();
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]!).toMatchObject({ kind: 'create', path: 'src/user.ts' });
    expect(plan.summary).toMatchObject({ created: 1, modified: 0, deleted: 0 });
  });

  it('demotes create to modify when the target exists, with overwrite warning', async () => {
    const abs = path.join(tmp, 'app.ts');
    await fs.writeFile(abs, 'old\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'add resource app');
    await b.create('app.ts', 'new\n');
    const plan = b.build();
    expect(plan.changes[0]!).toMatchObject({ kind: 'modify', oldContent: 'old\n', newContent: 'new\n' });
    expect(plan.warnings.some((w) => w.code === 'overwrite')).toBe(true);
  });

  it('rejects duplicate paths', async () => {
    const b = new PlanBuilder(tmp, 'test');
    await b.create('a.ts', '1');
    await expect(b.create('a.ts', '2')).rejects.toThrow(/planned twice/);
  });

  it('flags no-op modifies in summary.unchanged but keeps them in changes', async () => {
    await fs.writeFile(path.join(tmp, 'x.ts'), 'same\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.modify('x.ts', 'same\n');
    const plan = b.build();
    expect(plan.summary.unchanged).toBe(1);
    expect(plan.summary.modified).toBe(0);
    expect(plan.changes).toHaveLength(1);
  });

  it('normalizes windows-style paths to posix', async () => {
    const b = new PlanBuilder(tmp, 'test');
    await b.create('src\\foo\\bar.ts'.split('\\').join(path.sep), 'x');
    const plan = b.build();
    expect(plan.changes[0]!.path).toBe('src/foo/bar.ts');
  });

  it('skips delete of a non-existent file with a warning', async () => {
    const b = new PlanBuilder(tmp, 'test');
    await b.delete('missing.ts');
    const plan = b.build();
    expect(plan.changes).toHaveLength(0);
    expect(plan.warnings[0]!.code).toBe('no-op-delete');
  });

  it('build() produces a frozen changes array', async () => {
    const b = new PlanBuilder(tmp, 'test');
    await b.create('a.ts', '1');
    const plan = b.build();
    expect(Object.isFrozen(plan.changes)).toBe(true);
  });
});
