import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { PlanBuilder } from './plan-builder.js';
import { renderPlan } from './plan-renderer.js';

describe('renderPlan', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-render-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('renders an empty plan with a no-changes marker', () => {
    const plan = new PlanBuilder(tmp, 'add resource noop').build();
    const out = renderPlan(plan, { color: false });
    expect(out).toContain('PREVIEW');
    expect(out).toContain('No filesystem changes.');
    expect(out).toContain('Nothing was written');
  });

  it('renders a create with a preview body', async () => {
    const b = new PlanBuilder(tmp, 'add resource user');
    await b.create('src/user.ts', 'export const u = 1;\n', 'user model');
    const out = renderPlan(b.build(), { color: false });
    expect(out).toContain('create');
    expect(out).toContain('src/user.ts');
    expect(out).toContain('user model');
    expect(out).toContain('+export const u = 1;');
  });

  it('renders a modify with a unified diff', async () => {
    await fs.writeFile(path.join(tmp, 'a.ts'), 'one\ntwo\nthree\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'modify');
    await b.modify('a.ts', 'one\nTWO\nthree\n');
    const out = renderPlan(b.build(), { color: false });
    expect(out).toContain('modify');
    expect(out).toMatch(/-two/);
    expect(out).toMatch(/\+TWO/);
  });

  it('includes warnings section when warnings exist', async () => {
    await fs.writeFile(path.join(tmp, 'x.ts'), 'old\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.create('x.ts', 'new\n');
    const out = renderPlan(b.build(), { color: false });
    expect(out).toContain('Warnings');
    expect(out).toContain('will be overwritten');
  });

  it('summary counts match builder summary', async () => {
    await fs.writeFile(path.join(tmp, 'e.ts'), 'v1\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.create('n.ts', 'x');
    await b.modify('e.ts', 'v2\n');
    const out = renderPlan(b.build(), { color: false });
    expect(out).toContain('+1 created');
    expect(out).toContain('~1 modified');
  });
});
