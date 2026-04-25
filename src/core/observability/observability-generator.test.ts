import { describe, it, expect } from 'vitest';
import { ObservabilityGenerator } from './observability-generator.js';
import type { PillarConfig } from '../config/index.js';
import type { Stack, Architecture } from '../../utils/constants.js';

function makeConfig(overrides: Partial<{
  stack: Stack;
  architecture: Architecture;
  language: 'typescript' | 'javascript';
}> = {}): PillarConfig {
  return {
    project: {
      name: 'test',
      platform: 'web',
      category: 'api',
      stack: overrides.stack ?? 'express',
      language: overrides.language ?? 'typescript',
      architecture: overrides.architecture ?? 'feature-first',
      packageManager: 'npm',
    },
    database: { type: 'postgresql', orm: 'none' },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: false },
    map: { autoUpdate: true, format: ['json', 'markdown'] },
    extras: { docker: false, linting: false, gitHooks: false },
    doctor: { tscTimeoutMs: 60_000 },
  };
}

describe('ObservabilityGenerator', () => {
  it('rejects JavaScript projects', () => {
    expect(() => new ObservabilityGenerator(makeConfig({ language: 'javascript' })).generate())
      .toThrow(/TypeScript/);
  });

  it('emits the universal core files for every stack', () => {
    for (const stack of ['express', 'fastify', 'hono', 'nestjs', 'nextjs'] as const) {
      const { files } = new ObservabilityGenerator(makeConfig({ stack })).generate();
      const names = files.map((f) => f.relativePath.split('/').pop());
      expect(names).toContain('logger.ts');
      expect(names).toContain('request-context.ts');
      expect(names).toContain('request-id.ts');
      expect(names).toContain('http-logger.ts');
      expect(names).toContain('error-handler.ts');
    }
  });

  it('emits health.ts for non-Next stacks but route handlers for Next', () => {
    const nonNext = new ObservabilityGenerator(makeConfig({ stack: 'express' })).generate();
    expect(nonNext.files.some((f) => f.relativePath.endsWith('health.ts'))).toBe(true);

    const next = new ObservabilityGenerator(makeConfig({ stack: 'nextjs' })).generate();
    const paths = next.files.map((f) => f.relativePath);
    expect(paths).toContain('src/app/api/health/route.ts');
    expect(paths).toContain('src/app/api/ready/route.ts');
    expect(paths.find((p) => p.endsWith('observability/health.ts'))).toBeUndefined();
  });

  it('emits NestJS observability.module wiring filter + interceptor + middleware', () => {
    const { files } = new ObservabilityGenerator(makeConfig({ stack: 'nestjs' })).generate();
    const mod = files.find((f) => f.relativePath.endsWith('observability.module.ts'))!;
    expect(mod).toBeDefined();
    expect(mod.content).toContain('HealthController');
    expect(mod.content).toContain('APP_INTERCEPTOR');
    expect(mod.content).toContain('APP_FILTER');
    expect(mod.content).toContain('RequestIdMiddleware');
  });

  it('uses the right baseDir per architecture', () => {
    const layered = new ObservabilityGenerator(makeConfig({ architecture: 'layered' })).generate();
    expect(layered.files.some((f) => f.relativePath === 'src/observability/logger.ts')).toBe(true);

    const modular = new ObservabilityGenerator(makeConfig({ architecture: 'modular' })).generate();
    expect(modular.files.some((f) => f.relativePath === 'src/modules/observability/logger.ts')).toBe(true);

    const ff = new ObservabilityGenerator(makeConfig({ architecture: 'feature-first' })).generate();
    expect(ff.files.some((f) => f.relativePath === 'src/features/observability/logger.ts')).toBe(true);
  });

  it('Fastify request-id is shaped as a plugin (FastifyInstance)', () => {
    const { files } = new ObservabilityGenerator(makeConfig({ stack: 'fastify' })).generate();
    const rid = files.find((f) => f.relativePath.endsWith('request-id.ts'))!;
    expect(rid.content).toContain('FastifyInstance');
    expect(rid.content).toContain('addHook');
  });

  it('Hono request-id is shaped as MiddlewareHandler', () => {
    const { files } = new ObservabilityGenerator(makeConfig({ stack: 'hono' })).generate();
    const rid = files.find((f) => f.relativePath.endsWith('request-id.ts'))!;
    expect(rid.content).toContain('MiddlewareHandler');
  });

  it('Express request-id is shaped as Express middleware', () => {
    const { files } = new ObservabilityGenerator(makeConfig({ stack: 'express' })).generate();
    const rid = files.find((f) => f.relativePath.endsWith('request-id.ts'))!;
    expect(rid.content).toContain("from 'express'");
    expect(rid.content).toContain('NextFunction');
  });

  it('logger redacts sensitive paths', () => {
    const { files } = new ObservabilityGenerator(makeConfig()).generate();
    const lg = files.find((f) => f.relativePath.endsWith('logger.ts'))!;
    expect(lg.content).toContain('redact');
    expect(lg.content).toContain('authorization');
    expect(lg.content).toMatch(/\*\.password/);
  });

  it('declares pino + pino-pretty deps and LOG_LEVEL/LOG_PRETTY env', () => {
    const { dependencies, devDependencies, envKeys } = new ObservabilityGenerator(makeConfig()).generate();
    expect(dependencies).toHaveProperty('pino');
    expect(devDependencies).toHaveProperty('pino-pretty');
    expect(envKeys.map((e) => e.key).sort()).toEqual(['LOG_LEVEL', 'LOG_PRETTY']);
  });

  it('every file has a Purpose header', () => {
    for (const stack of ['express', 'fastify', 'hono', 'nestjs', 'nextjs'] as const) {
      const { files } = new ObservabilityGenerator(makeConfig({ stack })).generate();
      for (const f of files) {
        expect(
          f.content.startsWith('// Purpose:'),
          `${stack}/${f.relativePath} must start with Purpose header`,
        ).toBe(true);
      }
    }
  });
});
