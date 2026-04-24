import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PillarConfig } from '../core/config/index.js';
import {
  maybeAutoGenerateMigration,
  buildMigrationSlug,
} from './_post-schema-hook.js';

/**
 * These tests cover the planning + guard layer of the auto-migration
 * hook. Actual `runCommand` execution is exercised by the existing db
 * command tests; here we only verify:
 *
 *   - the hook is a no-op when the flag is off
 *   - the hook emits a skip warning when the adapter is unsupported
 *     (Mongoose, Drizzle-with-no-schema, etc.)
 *   - preview mode prints what would run and does not execute
 *   - the name slug is deterministic, sanitized, and length-capped
 */

function mkConfig(opts: {
  orm: PillarConfig['database']['orm'];
  autoGenerate?: boolean;
}): PillarConfig {
  return {
    project: {
      name: 't', platform: 'web', category: 'api',
      stack: 'express', language: 'typescript',
      architecture: 'feature-first', packageManager: 'npm',
    },
    database: {
      type: 'postgresql',
      orm: opts.orm,
      ...(opts.autoGenerate !== undefined
        ? {
            migrations: {
              autoGenerateOnFieldAdd: opts.autoGenerate,
            },
          }
        : {}),
    },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: false, format: ['json'] },
    extras: { docker: false, linting: false, gitHooks: false },
    doctor: { tscTimeoutMs: 60_000 },
  } as PillarConfig;
}

describe('buildMigrationSlug', () => {
  it('produces add_<subject>_fields for field reason', () => {
    expect(buildMigrationSlug('field', 'user')).toBe('add_user_fields');
  });

  it('produces add_<subject>_relation for relation reason', () => {
    expect(buildMigrationSlug('relation', 'user_post_one-to-many'))
      .toBe('add_user_post_one_to_many_relation');
  });

  it('lowercases and collapses non-alphanumerics', () => {
    expect(buildMigrationSlug('field', 'MyResource--Name!!'))
      .toBe('add_myresource_name_fields');
  });

  it('falls back to "change" when subject is empty after cleaning', () => {
    expect(buildMigrationSlug('field', '---')).toBe('add_change_fields');
  });

  it('caps slug length at 60 and strips trailing underscores', () => {
    const long = 'a'.repeat(200);
    const slug = buildMigrationSlug('field', long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('_')).toBe(false);
    expect(slug.startsWith('add_')).toBe(true);
  });
});

describe('maybeAutoGenerateMigration', () => {
  let logs: string[];
  let errs: string[];
  let origExit: number | string | undefined;

  beforeEach(() => {
    logs = [];
    errs = [];
    origExit = process.exitCode;
    process.exitCode = 0;
    vi.spyOn(console, 'log').mockImplementation((...a) => { logs.push(a.join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...a) => { errs.push(a.join(' ')); });
  });

  afterEach(() => {
    process.exitCode = origExit as number;
    vi.restoreAllMocks();
  });

  it('is a no-op when autoGenerateOnFieldAdd is absent', async () => {
    await maybeAutoGenerateMigration({
      projectRoot: '/tmp/x',
      config: mkConfig({ orm: 'prisma' }),
      reason: 'field',
      subject: 'user',
    });
    expect(logs.join('\n')).toBe('');
    expect(errs.join('\n')).toBe('');
    expect(process.exitCode).toBe(0);
  });

  it('is a no-op when autoGenerateOnFieldAdd is false', async () => {
    await maybeAutoGenerateMigration({
      projectRoot: '/tmp/x',
      config: mkConfig({ orm: 'prisma', autoGenerate: false }),
      reason: 'field',
      subject: 'user',
    });
    expect(logs.join('\n')).toBe('');
  });

  it('preview mode prints the plan and does not execute', async () => {
    await maybeAutoGenerateMigration({
      projectRoot: '/tmp/x',
      config: mkConfig({ orm: 'prisma', autoGenerate: true }),
      reason: 'field',
      subject: 'user',
      preview: true,
    });
    const combined = logs.join('\n');
    expect(combined).toMatch(/autoGenerateOnFieldAdd=true/);
    expect(combined).toMatch(/would also run/);
    expect(combined).toMatch(/add_user_fields/);
    expect(process.exitCode).toBe(0);
  });

  it('warns and skips when adapter is unsupported (Mongoose)', async () => {
    await maybeAutoGenerateMigration({
      projectRoot: '/tmp/x',
      config: mkConfig({ orm: 'mongoose', autoGenerate: true }),
      reason: 'field',
      subject: 'user',
      preview: true,
    });
    const combined = logs.join('\n');
    expect(combined).toMatch(/auto-migration skipped/);
    expect(combined).toMatch(/Mongoose/);
    // Not considered a failure — preview mode + unsupported = soft skip.
    expect(process.exitCode).toBe(0);
  });

  it('builds a relation slug from the composite subject', async () => {
    await maybeAutoGenerateMigration({
      projectRoot: '/tmp/x',
      config: mkConfig({ orm: 'prisma', autoGenerate: true }),
      reason: 'relation',
      subject: 'user_post_one-to-many',
      preview: true,
    });
    expect(logs.join('\n')).toMatch(/add_user_post_one_to_many_relation/);
  });
});
