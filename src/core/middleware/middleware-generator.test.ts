import { describe, it, expect } from 'vitest';
import { MiddlewareGenerator, SUPPORTED_MIDDLEWARE_KINDS, type MiddlewareKind } from './middleware-generator.js';
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

const ALL_STACKS: readonly Stack[] = ['express', 'fastify', 'nestjs', 'hono', 'nextjs'] as const;

describe('MiddlewareGenerator', () => {
  it('rejects JavaScript projects', () => {
    expect(() =>
      new MiddlewareGenerator(makeConfig({ language: 'javascript' }), 'cors').generate(),
    ).toThrow(/TypeScript/);
  });

  it('rejects unsupported kinds', () => {
    expect(() =>
      new MiddlewareGenerator(makeConfig(), 'bogus' as MiddlewareKind).generate(),
    ).toThrow(/Unsupported middleware kind/);
  });

  describe.each(SUPPORTED_MIDDLEWARE_KINDS)('kind=%s', (kind) => {
    it.each(ALL_STACKS)('emits exactly one file under src/middleware/ for stack=%s', (stack) => {
      const { files } = new MiddlewareGenerator(makeConfig({ stack }), kind).generate();
      expect(files).toHaveLength(1);
      expect(files[0]!.relativePath).toBe(`src/middleware/${kind}.middleware.ts`);
      expect(files[0]!.content.startsWith('// Purpose:')).toBe(true);
    });

    it.each(ALL_STACKS)('returns a stable purpose string for stack=%s', (stack) => {
      const { files } = new MiddlewareGenerator(makeConfig({ stack }), kind).generate();
      expect(files[0]!.purpose.length).toBeGreaterThan(0);
    });
  });

  // --- cors -----------------------------------------------------------------

  describe('cors', () => {
    it('express uses the `cors` package + @types/cors', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'express' }), 'cors').generate();
      expect(r.dependencies).toHaveProperty('cors');
      expect(r.devDependencies).toHaveProperty('@types/cors');
      expect(r.files[0]!.content).toContain("from 'cors'");
      expect(r.wiring?.target).toBe('app-module-scope');
      expect(r.importBinding).toBe('corsMiddleware');
    });

    it('fastify uses @fastify/cors and wires inside the factory', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'fastify' }), 'cors').generate();
      expect(r.dependencies).toHaveProperty('@fastify/cors');
      expect(r.files[0]!.content).toContain("from '@fastify/cors'");
      expect(r.wiring?.target).toBe('fastify-factory-body');
    });

    it('nestjs wires into bootstrap via app.enableCors', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'nestjs' }), 'cors').generate();
      expect(r.wiring?.target).toBe('nest-bootstrap-body');
      expect(r.wiring?.statement).toContain('app.enableCors');
      expect(r.importBinding).toBe('corsOptions');
    });

    it('hono uses the built-in hono/cors (no npm deps)', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'hono' }), 'cors').generate();
      expect(r.dependencies).toEqual({});
      expect(r.files[0]!.content).toContain("from 'hono/cors'");
    });

    it('nextjs emits a helper with no auto-wiring', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'nextjs' }), 'cors').generate();
      expect(r.wiring).toBeNull();
      expect(r.importBinding).toBeNull();
      expect(r.importFrom).toBeNull();
      expect(r.files[0]!.content).toContain('applyCorsHeaders');
    });

    it('contributes CORS_ORIGIN as an env key on every stack', () => {
      for (const stack of ALL_STACKS) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'cors').generate();
        expect(r.envKeys.map((e) => e.key)).toContain('CORS_ORIGIN');
      }
    });
  });

  // --- rate-limit -----------------------------------------------------------

  describe('rate-limit', () => {
    it('contributes RATE_LIMIT_* env keys', () => {
      const r = new MiddlewareGenerator(makeConfig(), 'rate-limit').generate();
      const keys = r.envKeys.map((e) => e.key);
      expect(keys).toContain('RATE_LIMIT_WINDOW_MS');
      expect(keys).toContain('RATE_LIMIT_MAX');
    });

    it('express uses express-rate-limit', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'express' }), 'rate-limit').generate();
      expect(r.dependencies).toHaveProperty('express-rate-limit');
    });

    it('fastify uses @fastify/rate-limit', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'fastify' }), 'rate-limit').generate();
      expect(r.dependencies).toHaveProperty('@fastify/rate-limit');
    });

    it('hono uses hono-rate-limiter', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'hono' }), 'rate-limit').generate();
      expect(r.dependencies).toHaveProperty('hono-rate-limiter');
    });

    it('nextjs emits an in-memory token bucket helper', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'nextjs' }), 'rate-limit').generate();
      expect(r.files[0]!.content).toContain('checkRateLimit');
      expect(r.wiring).toBeNull();
    });

    it('returns 429 semantics in templates that render a response', () => {
      for (const stack of ['hono', 'express', 'fastify'] as const) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'rate-limit').generate();
        expect(r.files[0]!.content).toMatch(/RATE_LIMITED|429/);
      }
    });
  });

  // --- helmet ---------------------------------------------------------------

  describe('helmet', () => {
    it('express/nestjs use the helmet package', () => {
      for (const stack of ['express', 'nestjs'] as const) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'helmet').generate();
        expect(r.dependencies).toHaveProperty('helmet');
      }
    });

    it('fastify uses @fastify/helmet', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'fastify' }), 'helmet').generate();
      expect(r.dependencies).toHaveProperty('@fastify/helmet');
    });

    it('hono ships a no-dep header middleware', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'hono' }), 'helmet').generate();
      expect(r.dependencies).toEqual({});
      expect(r.files[0]!.content).toContain('Content-Security-Policy');
    });

    it('has no env keys (secure defaults only)', () => {
      const r = new MiddlewareGenerator(makeConfig({ stack: 'express' }), 'helmet').generate();
      expect(r.envKeys).toEqual([]);
    });

    it('every non-next template sets HSTS with a 1-year max-age', () => {
      for (const stack of ['express', 'fastify', 'hono', 'nestjs'] as const) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'helmet').generate();
        expect(r.files[0]!.content).toMatch(/31[_.,]?536[_.,]?000|max-age=31536000/);
      }
    });
  });

  // --- request-id -----------------------------------------------------------

  describe('request-id', () => {
    it('has no npm deps on any stack (uses node:crypto randomUUID)', () => {
      for (const stack of ALL_STACKS) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'request-id').generate();
        expect(r.dependencies).toEqual({});
        expect(r.devDependencies).toEqual({});
      }
    });

    it('honors inbound x-request-id header', () => {
      for (const stack of ALL_STACKS) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), 'request-id').generate();
        expect(r.files[0]!.content).toContain('x-request-id');
      }
    });

    it('has no env keys', () => {
      const r = new MiddlewareGenerator(makeConfig(), 'request-id').generate();
      expect(r.envKeys).toEqual([]);
    });
  });

  // --- wiring import resolution --------------------------------------------

  describe('import resolution', () => {
    it('importFrom is set when wiring is present', () => {
      for (const kind of SUPPORTED_MIDDLEWARE_KINDS) {
        for (const stack of ['express', 'fastify', 'nestjs', 'hono'] as const) {
          const r = new MiddlewareGenerator(makeConfig({ stack }), kind).generate();
          expect(r.wiring).not.toBeNull();
          expect(r.importFrom).toBe(`./middleware/${kind}.middleware.js`);
          expect(r.importBinding).toBeTruthy();
        }
      }
    });

    it('importFrom is null when wiring is null (nextjs)', () => {
      for (const kind of SUPPORTED_MIDDLEWARE_KINDS) {
        const r = new MiddlewareGenerator(makeConfig({ stack: 'nextjs' }), kind).generate();
        expect(r.wiring).toBeNull();
        expect(r.importFrom).toBeNull();
      }
    });
  });

  // --- structural invariants -----------------------------------------------

  it('path is always src/middleware/<kind>.middleware.ts regardless of architecture', () => {
    for (const architecture of ['feature-first', 'layered', 'modular'] as const) {
      for (const kind of SUPPORTED_MIDDLEWARE_KINDS) {
        const r = new MiddlewareGenerator(makeConfig({ architecture }), kind).generate();
        expect(r.files[0]!.relativePath).toBe(`src/middleware/${kind}.middleware.ts`);
      }
    }
  });

  it('every emitted source file uses ESM .js import suffixes (Node16 resolution)', () => {
    for (const kind of SUPPORTED_MIDDLEWARE_KINDS) {
      for (const stack of ALL_STACKS) {
        const r = new MiddlewareGenerator(makeConfig({ stack }), kind).generate();
        const content = r.files[0]!.content;
        // Relative imports (./ or ../) must always end with .js
        const relativeImports = content.match(/from\s+'(\.\/|\.\.\/)[^']+'/g) ?? [];
        for (const imp of relativeImports) {
          expect(imp, `${kind}/${stack}: relative import must end with .js: ${imp}`).toMatch(/\.js'$/);
        }
      }
    }
  });
});
