import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile } from '../generator/types.js';
import {
  authControllerSource,
  authMiddlewareSource,
  authRepositorySource,
  authRoutesSource,
  authServiceSource,
  authTypesSource,
  authValidatorSource,
  jwtUtilSource,
  nestAuthModuleSource,
  nextAuthRouteSource,
  type AuthTemplateContext,
} from './templates.js';

export type AuthStrategy = 'jwt';

export interface AuthGenerationResult {
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  envKeys: Array<{ key: string; defaultValue: string; comment: string }>;
}

/**
 * Generate a stack- and architecture-aware authentication scaffold.
 *
 * The generator is a *pure function over config* — it never touches the
 * filesystem. The caller (commands/auth.ts) is responsible for:
 *   1. Writing files (respecting --force / --dry-run)
 *   2. Recording a history entry so `pillar undo` can reverse the scaffold
 *   3. Updating package.json + .env.example
 *   4. Registering purposes in the project map
 *
 * This separation keeps the generator trivially testable and preserves
 * the single-source-of-truth discipline (all file emission goes through
 * the command layer's spinner + conflict checks).
 */
export class AuthGenerator {
  constructor(
    private readonly config: PillarConfig,
    private readonly strategy: AuthStrategy,
  ) {}

  generate(): AuthGenerationResult {
    if (this.config.project.language !== 'typescript') {
      throw new Error(
        'pillar add auth requires a TypeScript project. JavaScript auth scaffolds are not supported — ' +
          'the generated code depends on compile-time types from zod + jsonwebtoken.',
      );
    }
    if (this.strategy !== 'jwt') {
      throw new Error(`Unsupported auth strategy: ${this.strategy as string}`);
    }

    const baseDir = this.baseDir();
    const stack = this.config.project.stack;

    const ctx: AuthTemplateContext = {
      peer: (suffix: string) => `./auth.${suffix}.js`,
      isTS: true,
    };
    // Special peer alias for NestJS guard (lives as auth.guard.ts).
    const ctxWithGuard: AuthTemplateContext = {
      peer: (suffix: string) => (suffix === 'guard' ? './auth.guard.js' : `./auth.${suffix}.js`),
      isTS: true,
    };
    // jwt.util lives alongside the rest but keeps its own extension token.
    const wrappedCtx: AuthTemplateContext = {
      peer: (suffix: string) => {
        if (suffix === 'jwt.util') return './jwt.util.js';
        if (suffix === 'guard') return './auth.guard.js';
        return `./auth.${suffix}.js`;
      },
      isTS: true,
    };

    const files: GeneratedFile[] = [];

    files.push({
      relativePath: `${baseDir}/auth.types.ts`,
      content: authTypesSource(this.config, ctx),
      purpose: 'Auth module types (AuthUser, PublicUser, AuthResponse).',
    });
    files.push({
      relativePath: `${baseDir}/auth.validator.ts`,
      content: authValidatorSource(this.config, ctx),
      purpose: 'Zod schemas + inferred input types for /auth endpoints.',
    });
    files.push({
      relativePath: `${baseDir}/auth.repository.ts`,
      content: authRepositorySource(this.config, ctx),
      purpose: 'User persistence for auth (in-memory stub — swap for your DB layer).',
    });
    files.push({
      relativePath: `${baseDir}/jwt.util.ts`,
      content: jwtUtilSource(this.config, ctx),
      purpose: 'Sign and verify JWTs using JWT_SECRET / JWT_EXPIRES_IN from the environment.',
    });
    files.push({
      relativePath: `${baseDir}/auth.service.ts`,
      content: authServiceSource(this.config, wrappedCtx),
      purpose: 'Auth business logic: register, login, and token introspection.',
    });
    files.push({
      relativePath: `${baseDir}/auth.controller.ts`,
      content: authControllerSource(this.config, stack === 'nestjs' ? ctxWithGuard : ctx),
      purpose: stack === 'nextjs'
        ? 'Shared handler functions consumed by the Next.js App Router routes.'
        : 'HTTP handlers for POST /auth/register, POST /auth/login, GET /auth/me.',
    });
    files.push({
      relativePath: `${baseDir}/auth.middleware.ts`,
      content: authMiddlewareSource(this.config, ctx),
      purpose: stack === 'nestjs'
        ? 'Authentication guard (attached to /auth/me via @UseGuards).'
        : stack === 'nextjs'
          ? 'Authentication helper for Next.js route handlers.'
          : 'Middleware that verifies a Bearer JWT and attaches the user to the request.',
    });

    if (stack === 'express' || stack === 'fastify' || stack === 'hono') {
      files.push({
        relativePath: `${baseDir}/auth.routes.ts`,
        content: authRoutesSource(this.config, ctx),
        purpose: 'Route definitions for the auth endpoints.',
      });
    }

    if (stack === 'nestjs') {
      // Rename middleware file: Nest calls it a Guard. Keep a deterministic
      // name so the controller's `${ctx.peer('guard')}` import resolves.
      const idx = files.findIndex((f) => f.relativePath === `${baseDir}/auth.middleware.ts`);
      if (idx !== -1) {
        files[idx] = {
          ...files[idx]!,
          relativePath: `${baseDir}/auth.guard.ts`,
        };
      }
      files.push({
        relativePath: `${baseDir}/auth.module.ts`,
        content: nestAuthModuleSource(this.config, ctxWithGuard),
        purpose: 'NestJS AuthModule — registers AuthController + AuthService + AuthGuard.',
      });
    }

    if (stack === 'nextjs') {
      const importPrefix = this.nextImportPrefix();
      for (const endpoint of ['register', 'login', 'me'] as const) {
        files.push({
          relativePath: `src/app/api/auth/${endpoint}/route.ts`,
          content: nextAuthRouteSource(endpoint, importPrefix),
          purpose: `Next.js App Router handler for ${endpoint === 'me' ? 'GET' : 'POST'} /api/auth/${endpoint}.`,
        });
      }
    }

    return {
      files,
      dependencies: {
        jsonwebtoken: '^9.0.2',
        bcryptjs: '^2.4.3',
      },
      devDependencies: {
        '@types/jsonwebtoken': '^9.0.7',
        '@types/bcryptjs': '^2.4.6',
      },
      envKeys: [
        {
          key: 'JWT_SECRET',
          defaultValue: 'change-me-to-a-long-random-string',
          comment: 'Min 16 chars. Rotate to invalidate all issued tokens.',
        },
        {
          key: 'JWT_EXPIRES_IN',
          defaultValue: '1h',
          comment: 'JWT lifetime (e.g., 15m, 1h, 7d).',
        },
      ],
    };
  }

  /**
   * Where the auth module lives on disk.
   *
   * Feature-first and modular place it under their standard feature root.
   * Layered is the exception: auth is a small, cohesive cross-cutting
   * concern, so we keep it consolidated under `src/auth/` rather than
   * scattering files across `controllers/`, `services/`, etc. Users who
   * want strict layer placement can move the files manually; the arch-lint
   * (feature-first/modular-only) doesn't flag either layout.
   */
  private baseDir(): string {
    const arch = this.config.project.architecture;
    switch (arch) {
      case 'feature-first': return 'src/features/auth';
      case 'modular':       return 'src/modules/auth';
      case 'layered':       return 'src/auth';
    }
  }

  /**
   * Next.js uses the `@/` baseUrl alias by convention; fall back to a
   * relative path from `src/app/api/auth/<endpoint>/` if not.
   */
  private nextImportPrefix(): string {
    const arch = this.config.project.architecture;
    switch (arch) {
      case 'feature-first': return '@/features/auth';
      case 'modular':       return '@/modules/auth';
      case 'layered':       return '@/auth';
    }
  }
}
