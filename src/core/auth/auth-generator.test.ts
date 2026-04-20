import { describe, it, expect } from 'vitest';
import { AuthGenerator } from './auth-generator.js';
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

describe('AuthGenerator', () => {
  it('rejects JavaScript projects', () => {
    expect(() => new AuthGenerator(makeConfig({ language: 'javascript' }), 'jwt').generate())
      .toThrow(/TypeScript/);
  });

  it('rejects unsupported strategies', () => {
    expect(() => new AuthGenerator(makeConfig(), 'session' as never).generate())
      .toThrow(/Unsupported auth strategy/);
  });

  it('emits the expected file set for express + feature-first', () => {
    const { files, dependencies, devDependencies, envKeys } = new AuthGenerator(makeConfig(), 'jwt').generate();
    const paths = files.map((f) => f.relativePath);

    expect(paths).toContain('src/features/auth/auth.types.ts');
    expect(paths).toContain('src/features/auth/auth.validator.ts');
    expect(paths).toContain('src/features/auth/auth.repository.ts');
    expect(paths).toContain('src/features/auth/auth.service.ts');
    expect(paths).toContain('src/features/auth/auth.controller.ts');
    expect(paths).toContain('src/features/auth/auth.middleware.ts');
    expect(paths).toContain('src/features/auth/auth.routes.ts');
    expect(paths).toContain('src/features/auth/jwt.util.ts');

    expect(dependencies).toHaveProperty('jsonwebtoken');
    expect(dependencies).toHaveProperty('bcryptjs');
    expect(devDependencies).toHaveProperty('@types/jsonwebtoken');
    expect(envKeys.map((e) => e.key)).toEqual(['JWT_SECRET', 'JWT_EXPIRES_IN']);
  });

  it('places files under src/modules/auth for modular architecture', () => {
    const { files } = new AuthGenerator(makeConfig({ architecture: 'modular' }), 'jwt').generate();
    expect(files.every((f) => f.relativePath.startsWith('src/modules/auth/') || f.relativePath.startsWith('src/app/'))).toBe(true);
  });

  it('places files under src/auth for layered architecture', () => {
    const { files } = new AuthGenerator(makeConfig({ architecture: 'layered' }), 'jwt').generate();
    expect(files.some((f) => f.relativePath === 'src/auth/auth.service.ts')).toBe(true);
  });

  it('emits Fastify controller with FastifyRequest/Reply types', () => {
    const { files } = new AuthGenerator(makeConfig({ stack: 'fastify' }), 'jwt').generate();
    const controller = files.find((f) => f.relativePath.endsWith('auth.controller.ts'))!;
    expect(controller.content).toContain('FastifyRequest');
    expect(controller.content).toContain('FastifyReply');
  });

  it('emits Hono controller that uses Context', () => {
    const { files } = new AuthGenerator(makeConfig({ stack: 'hono' }), 'jwt').generate();
    const controller = files.find((f) => f.relativePath.endsWith('auth.controller.ts'))!;
    expect(controller.content).toContain("from 'hono'");
    expect(controller.content).toContain('Context');
  });

  it('emits NestJS auth module + guard (not middleware)', () => {
    const { files } = new AuthGenerator(makeConfig({ stack: 'nestjs' }), 'jwt').generate();
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('src/features/auth/auth.module.ts');
    expect(paths).toContain('src/features/auth/auth.guard.ts');
    expect(paths).not.toContain('src/features/auth/auth.middleware.ts');
    expect(paths).not.toContain('src/features/auth/auth.routes.ts'); // decorators handle routing

    const moduleFile = files.find((f) => f.relativePath.endsWith('auth.module.ts'))!;
    expect(moduleFile.content).toContain('AuthController');
    expect(moduleFile.content).toContain('AuthGuard');
  });

  it('emits Next.js App Router handlers for each endpoint', () => {
    const { files } = new AuthGenerator(makeConfig({ stack: 'nextjs' }), 'jwt').generate();
    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('src/app/api/auth/register/route.ts');
    expect(paths).toContain('src/app/api/auth/login/route.ts');
    expect(paths).toContain('src/app/api/auth/me/route.ts');
    expect(paths).not.toContain('src/features/auth/auth.routes.ts');
  });

  it('every file has a Purpose header', () => {
    const { files } = new AuthGenerator(makeConfig(), 'jwt').generate();
    for (const f of files) {
      expect(f.content.startsWith('// Purpose:'), `${f.relativePath} must start with Purpose header`).toBe(true);
    }
  });

  it('service introspects via verifyToken and never logs the password', () => {
    const { files } = new AuthGenerator(makeConfig(), 'jwt').generate();
    const service = files.find((f) => f.relativePath.endsWith('auth.service.ts'))!;
    expect(service.content).toContain('bcrypt.compare');
    expect(service.content).toContain('verifyToken');
    expect(service.content).not.toMatch(/console\.log\([^)]*password/i);
  });
});
