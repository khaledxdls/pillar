import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile } from '../generator/types.js';
import {
  buildMiddleware,
  SUPPORTED_MIDDLEWARE_KINDS,
  type MiddlewareEmission,
  type MiddlewareEnvKey,
  type MiddlewareKind,
  type MiddlewareWiring,
} from './templates.js';

export type { MiddlewareKind, MiddlewareWiring };
export { SUPPORTED_MIDDLEWARE_KINDS };

export interface MiddlewareGenerationResult {
  kind: MiddlewareKind;
  /** Single file emission — always `src/middleware/<kind>.middleware.ts`. */
  files: GeneratedFile[];
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  envKeys: MiddlewareEnvKey[];
  /** Wiring details for the command layer; `null` means "no auto-wiring for this stack". */
  wiring: MiddlewareWiring | null;
  /** Named import binding used by `wiring.statement`. Set when `wiring` is not null. */
  importBinding: string | null;
  /** ESM import specifier relative to the app entry (e.g. `./middleware/cors.middleware.js`). */
  importFrom: string | null;
}

/**
 * Pure function over `PillarConfig` — no filesystem, no side effects.
 *
 * The command layer (`src/commands/add.ts :: addMiddlewareCommand`) owns:
 *   - Writing the file (respecting --force / --dry-run)
 *   - Updating package.json + .env files
 *   - Splicing the wiring statement into app.ts / main.ts via AST
 *   - Recording a history entry for single-step undo
 *
 * Keeping the generator side-effect-free makes it trivially unit-testable
 * across all (kind, stack) permutations without mocking `fs`.
 */
export class MiddlewareGenerator {
  constructor(
    private readonly config: PillarConfig,
    private readonly kind: MiddlewareKind,
  ) {}

  generate(): MiddlewareGenerationResult {
    if (this.config.project.language !== 'typescript') {
      throw new Error(
        'pillar add middleware <kind> requires a TypeScript project. ' +
          'JavaScript middleware scaffolds are not supported — the templates depend on compile-time typing.',
      );
    }
    if (!SUPPORTED_MIDDLEWARE_KINDS.includes(this.kind)) {
      throw new Error(
        `Unsupported middleware kind: "${this.kind as string}". ` +
          `Supported: ${SUPPORTED_MIDDLEWARE_KINDS.join(', ')}.`,
      );
    }

    const emission: MiddlewareEmission = buildMiddleware(this.kind, this.config);
    const relativePath = `src/middleware/${this.kind}.middleware.ts`;

    const files: GeneratedFile[] = [
      {
        relativePath,
        content: emission.source,
        purpose: this.purposeFor(this.kind),
      },
    ];

    const importFrom = emission.wiring
      ? `./middleware/${this.kind}.middleware.js`
      : null;

    return {
      kind: this.kind,
      files,
      dependencies: emission.dependencies,
      devDependencies: emission.devDependencies,
      envKeys: emission.envKeys,
      wiring: emission.wiring,
      importBinding: emission.wiring?.importBinding ?? null,
      importFrom,
    };
  }

  private purposeFor(kind: MiddlewareKind): string {
    switch (kind) {
      case 'cors':        return 'CORS policy — origin list driven by CORS_ORIGIN env.';
      case 'rate-limit':  return 'Per-IP request rate limiting — window/max driven by RATE_LIMIT_* env.';
      case 'helmet':      return 'Secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.).';
      case 'request-id':  return 'Correlation-ID middleware — honors inbound x-request-id.';
    }
  }
}
