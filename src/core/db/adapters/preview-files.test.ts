import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import { readPendingMigrationSql } from './preview-files.js';

describe('readPendingMigrationSql', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-preview-'));
  });

  afterEach(async () => {
    await fs.remove(dir);
  });

  it('returns null when the directory does not exist', async () => {
    const result = await readPendingMigrationSql(path.join(dir, 'missing'), { extensions: ['.sql'] });
    expect(result).toBeNull();
  });

  it('returns null when the path is a file, not a directory', async () => {
    const file = path.join(dir, 'not-a-dir');
    await fs.writeFile(file, 'hi');
    const result = await readPendingMigrationSql(file, { extensions: ['.sql'] });
    expect(result).toBeNull();
  });

  it('returns null when no matching files exist', async () => {
    await fs.writeFile(path.join(dir, 'README.md'), '# notes');
    const result = await readPendingMigrationSql(dir, { extensions: ['.sql'] });
    expect(result).toBeNull();
  });

  it('concatenates matching files in lexicographic order', async () => {
    await fs.writeFile(path.join(dir, '0002_second.sql'), 'ALTER TABLE x;');
    await fs.writeFile(path.join(dir, '0001_first.sql'), 'CREATE TABLE x;');
    await fs.writeFile(path.join(dir, 'ignore.txt'), 'skip');

    const result = await readPendingMigrationSql(dir, { extensions: ['.sql'] });
    expect(result).not.toBeNull();
    const idxFirst = result!.indexOf('0001_first.sql');
    const idxSecond = result!.indexOf('0002_second.sql');
    expect(idxFirst).toBeGreaterThanOrEqual(0);
    expect(idxSecond).toBeGreaterThan(idxFirst);
    expect(result).toContain('CREATE TABLE x;');
    expect(result).toContain('ALTER TABLE x;');
  });

  it('supports multiple extensions', async () => {
    await fs.writeFile(path.join(dir, '001.ts'), 'export class A {}');
    await fs.writeFile(path.join(dir, '002.js'), 'module.exports = {};');
    const result = await readPendingMigrationSql(dir, { extensions: ['.ts', '.js'] });
    expect(result).toContain('001.ts');
    expect(result).toContain('002.js');
  });

  it('truncates files larger than maxBytesPerFile and marks it inline', async () => {
    const big = 'x'.repeat(200);
    await fs.writeFile(path.join(dir, '001.sql'), big);
    const result = await readPendingMigrationSql(dir, {
      extensions: ['.sql'],
      maxBytesPerFile: 50,
    });
    expect(result).toContain('(truncated');
    expect(result).not.toContain(big);
  });

  it('stops early when combined output exceeds maxTotalBytes', async () => {
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(path.join(dir, `00${i}.sql`), 'x'.repeat(100));
    }
    const result = await readPendingMigrationSql(dir, {
      extensions: ['.sql'],
      maxBytesPerFile: 100,
      maxTotalBytes: 200,
    });
    expect(result).toContain('more file(s) omitted');
  });

  it('ignores nested subdirectories', async () => {
    const nested = path.join(dir, 'meta');
    await fs.mkdir(nested);
    await fs.writeFile(path.join(nested, 'journal.json'), '{}');
    await fs.writeFile(path.join(dir, '001.sql'), 'CREATE TABLE y;');
    const result = await readPendingMigrationSql(dir, { extensions: ['.sql'] });
    expect(result).toContain('001.sql');
    expect(result).not.toContain('journal.json');
  });
});
