import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { PlanBuilder } from './plan-builder.js';
import { PlanExecutor, PlanExecutionError } from './plan-executor.js';

describe('PlanExecutor', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-exec-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
    vi.restoreAllMocks();
  });

  it('applies creates and modifies and returns FileOperations', async () => {
    await fs.writeFile(path.join(tmp, 'existing.ts'), 'old\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.create('new.ts', 'hello\n');
    await b.modify('existing.ts', 'new\n');

    const result = await new PlanExecutor(tmp).execute(b.build());

    expect(await fs.readFile(path.join(tmp, 'new.ts'), 'utf-8')).toBe('hello\n');
    expect(await fs.readFile(path.join(tmp, 'existing.ts'), 'utf-8')).toBe('new\n');
    expect(result.operations.map((o) => o.type)).toEqual(['create', 'modify']);
    expect(result.operations[1]!.previousContent).toBe('old\n');
  });

  it('rolls back already-applied changes when a later change fails', async () => {
    await fs.writeFile(path.join(tmp, 'keep.ts'), 'v1\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.create('made.ts', 'new\n');
    await b.modify('keep.ts', 'v2\n');
    const plan = b.build();

    const executor = new PlanExecutor(tmp);
    // Force the second write to fail by spying on fs.writeFile.
    const original = fs.writeFile.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (...args: Parameters<typeof original>) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      return original(...args);
    });

    await expect(executor.execute(plan)).rejects.toBeInstanceOf(PlanExecutionError);

    vi.restoreAllMocks();
    // `made.ts` should have been rolled back (file removed)
    expect(await fs.pathExists(path.join(tmp, 'made.ts'))).toBe(false);
    // `keep.ts` was never successfully modified, so still v1
    expect(await fs.readFile(path.join(tmp, 'keep.ts'), 'utf-8')).toBe('v1\n');
  });

  it('skips unchanged modifications by default', async () => {
    await fs.writeFile(path.join(tmp, 'same.ts'), 'same\n', 'utf-8');
    const b = new PlanBuilder(tmp, 'test');
    await b.modify('same.ts', 'same\n');
    const result = await new PlanExecutor(tmp).execute(b.build());
    expect(result.operations).toHaveLength(0);
  });
});
