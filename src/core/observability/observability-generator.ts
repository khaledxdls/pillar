import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile } from '../generator/types.js';
import {
  errorHandlerSource,
  healthSource,
  httpLoggerSource,
  loggerSource,
  nestObservabilityModuleSource,
  nextHealthRouteSource,
  requestContextSource,
  requestIdSource,
  type ObservabilityTemplateContext,
} from './templates.js';

export interface ObservabilityGenerationResult {
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  envKeys: Array<{ key: string; defaultValue: string; comment: string }>;
}

/**
 * Generate a stack- and architecture-aware observability scaffold.
 *
 * Like AuthGenerator this is a pure function over config — the caller
 * is responsible for filesystem writes, history records, package.json
 * mutations, env updates, and app-entry wiring.
 *
 * Pieces emitted (per stack):
 *   logger.ts                  — pino logger with request-bound child
 *   request-context.ts         — AsyncLocalStorage for {requestId}
 *   request-id.{mw|guard}.ts   — propagates X-Request-Id, runs ALS
 *   http-logger.ts             — structured access logging
 *   error-handler.ts           — terminal error → JSON
 *   health.ts                  — GET /health + GET /ready
 *   observability.module.ts    — (NestJS only) module wiring
 *   src/app/api/health|ready/route.ts — (Next.js only)
 */
export class ObservabilityGenerator {
  constructor(private readonly config: PillarConfig) {}

  generate(): ObservabilityGenerationResult {
    if (this.config.project.language !== 'typescript') {
      throw new Error(
        'pillar add observability requires a TypeScript project. ' +
          'The generated code depends on compile-time types from pino + the framework type packages.',
      );
    }

    const stack = this.config.project.stack;
    const baseDir = this.baseDir();

    const ctx: ObservabilityTemplateContext = {
      peer: (suffix) => `./${suffix}.js`,
    };

    const files: GeneratedFile[] = [];

    files.push({
      relativePath: `${baseDir}/request-context.ts`,
      content: requestContextSource(this.config),
      purpose: 'AsyncLocalStorage carrying per-request data (requestId).',
    });
    files.push({
      relativePath: `${baseDir}/logger.ts`,
      content: loggerSource(this.config, ctx),
      purpose: 'Pino logger; logger() returns a child bound to the current requestId.',
    });
    files.push({
      relativePath: `${baseDir}/request-id.ts`,
      content: requestIdSource(stack, ctx),
      purpose: 'Generates/propagates X-Request-Id and binds AsyncLocalStorage.',
    });
    files.push({
      relativePath: `${baseDir}/http-logger.ts`,
      content: httpLoggerSource(stack, ctx),
      purpose: 'Structured request/response logging with duration.',
    });
    files.push({
      relativePath: `${baseDir}/error-handler.ts`,
      content: errorHandlerSource(stack, ctx),
      purpose: 'Centralised error handler — logs and returns a structured JSON body.',
    });

    if (stack !== 'nextjs') {
      files.push({
        relativePath: `${baseDir}/health.ts`,
        content: healthSource(stack, ctx),
        purpose: 'GET /health (liveness) and GET /ready (readiness) endpoints.',
      });
    }

    if (stack === 'nestjs') {
      files.push({
        relativePath: `${baseDir}/observability.module.ts`,
        content: nestObservabilityModuleSource(this.config, ctx),
        purpose: 'NestJS module: HealthController + global interceptor/filter + RequestId middleware.',
      });
    }

    if (stack === 'nextjs') {
      const importPrefix = this.nextImportPrefix();
      files.push({
        relativePath: 'src/app/api/health/route.ts',
        content: nextHealthRouteSource(importPrefix, 'health'),
        purpose: 'Next.js App Router handler for GET /api/health.',
      });
      files.push({
        relativePath: 'src/app/api/ready/route.ts',
        content: nextHealthRouteSource(importPrefix, 'ready'),
        purpose: 'Next.js App Router handler for GET /api/ready.',
      });
    }

    return {
      files,
      dependencies: {
        pino: '^9.5.0',
      },
      devDependencies: {
        'pino-pretty': '^11.2.2',
      },
      envKeys: [
        {
          key: 'LOG_LEVEL',
          defaultValue: 'info',
          comment: 'pino log level: trace | debug | info | warn | error | fatal',
        },
        {
          key: 'LOG_PRETTY',
          defaultValue: 'false',
          comment: 'Set to "true" in dev for human-readable logs (uses pino-pretty).',
        },
      ],
    };
  }

  private baseDir(): string {
    const arch = this.config.project.architecture;
    switch (arch) {
      case 'feature-first': return 'src/features/observability';
      case 'modular':       return 'src/modules/observability';
      case 'layered':       return 'src/observability';
    }
  }

  private nextImportPrefix(): string {
    const arch = this.config.project.architecture;
    switch (arch) {
      case 'feature-first': return '@/features/observability';
      case 'modular':       return '@/modules/observability';
      case 'layered':       return '@/observability';
    }
  }
}
