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
