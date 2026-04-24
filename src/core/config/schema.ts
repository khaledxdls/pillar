import { z } from 'zod';
import {
  SUPPORTED_PLATFORMS,
  SUPPORTED_CATEGORIES,
  SUPPORTED_LANGUAGES,
  SUPPORTED_DATABASES,
  SUPPORTED_ORMS,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_PACKAGE_MANAGERS,
  SUPPORTED_TEST_FRAMEWORKS,
} from '../../utils/constants.js';

const allStacks = ['express', 'fastify', 'nestjs', 'hono', 'nextjs'] as const;

export const pillarConfigSchema = z.object({
  project: z.object({
    name: z.string().min(1),
    platform: z.enum(SUPPORTED_PLATFORMS),
    category: z.enum(SUPPORTED_CATEGORIES),
    stack: z.enum(allStacks),
    language: z.enum(SUPPORTED_LANGUAGES),
    architecture: z.enum(SUPPORTED_ARCHITECTURES),
    packageManager: z.enum(SUPPORTED_PACKAGE_MANAGERS),
  }),
  database: z.object({
    type: z.enum(SUPPORTED_DATABASES),
    orm: z.enum(SUPPORTED_ORMS),
    // Optional migration settings. Absent on projects predating the
    // `pillar db` command; populated lazily the first time a user edits
    // `pillar.config.json` to tune migration behavior.
    migrations: z.object({
      // Directory where migration files live. Adapters use sensible
      // defaults when omitted: `prisma/migrations` for Prisma,
      // `drizzle/` for Drizzle, `src/migrations/` for TypeORM.
      directory: z.string().optional(),
      // Path to the schema source — informational today, reserved for
      // adapters that need it for SQL preview when the default lookup
      // isn't enough (e.g., split Prisma schema files).
      schema: z.string().optional(),
      // If true, `add field` / `add relation` will auto-generate a
      // migration after the schema edit. Off by default — migrations
      // change the DB and should remain an explicit user action.
      autoGenerateOnFieldAdd: z.boolean().default(false),
    }).optional(),
  }),
  generation: z.object({
    overwrite: z.boolean().default(false),
    dryRun: z.boolean().default(false),
    testFramework: z.enum(SUPPORTED_TEST_FRAMEWORKS).default('vitest'),
    purposeRequired: z.boolean().default(true),
  }),
  map: z.object({
    autoUpdate: z.boolean().default(true),
    format: z.array(z.enum(['json', 'markdown'])).default(['json', 'markdown']),
  }),
  extras: z.object({
    docker: z.boolean().default(false),
    linting: z.boolean().default(false),
    gitHooks: z.boolean().default(false),
  }),
  doctor: z.object({
    // Time budget for `tsc --noEmit` in the type-checking diagnostic.
    // Large monorepos legitimately take longer than 30s; raise when needed.
    tscTimeoutMs: z.number().int().positive().default(60_000),
  }).default({ tscTimeoutMs: 60_000 }),
  // List of plugin specifiers — either bare npm package names or relative
  // paths. Optional for backwards compatibility with configs written
  // before the plugin system existed.
  plugins: z.array(z.string().min(1)).optional(),
});

export type PillarConfig = z.infer<typeof pillarConfigSchema>;

export const DEFAULT_GENERATION: PillarConfig['generation'] = {
  overwrite: false,
  dryRun: false,
  testFramework: 'vitest',
  purposeRequired: true,
};

export const DEFAULT_MAP: PillarConfig['map'] = {
  autoUpdate: true,
  format: ['json', 'markdown'],
};

export const DEFAULT_EXTRAS: PillarConfig['extras'] = {
  docker: false,
  linting: false,
  gitHooks: false,
};

export const DEFAULT_DOCTOR: PillarConfig['doctor'] = {
  tscTimeoutMs: 60_000,
};
