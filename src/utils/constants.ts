export const PILLAR_DIR = '.pillar' as const;
export const CONFIG_FILE = 'pillar.config.json' as const;
export const MAP_JSON_FILE = 'map.json' as const;
export const MAP_MD_FILE = 'map.md' as const;
export const HISTORY_FILE = 'history.json' as const;

export const PILLAR_MAP_JSON_PATH = `${PILLAR_DIR}/${MAP_JSON_FILE}` as const;
export const PILLAR_MAP_MD_PATH = `${PILLAR_DIR}/${MAP_MD_FILE}` as const;
export const PILLAR_HISTORY_PATH = `${PILLAR_DIR}/${HISTORY_FILE}` as const;

export const SUPPORTED_PLATFORMS = ['web'] as const;
export const SUPPORTED_CATEGORIES = ['api', 'fullstack'] as const;

export const SUPPORTED_STACKS = {
  api: ['express', 'fastify', 'nestjs', 'hono'],
  fullstack: ['nextjs'],
} as const;

export const SUPPORTED_LANGUAGES = ['typescript', 'javascript'] as const;
export const SUPPORTED_DATABASES = ['postgresql', 'mongodb', 'sqlite', 'none'] as const;
export const SUPPORTED_ORMS = ['prisma', 'drizzle', 'typeorm', 'mongoose', 'none'] as const;
export const SUPPORTED_ARCHITECTURES = ['feature-first', 'layered', 'modular'] as const;
export const SUPPORTED_PACKAGE_MANAGERS = ['npm', 'yarn', 'pnpm'] as const;
export const SUPPORTED_TEST_FRAMEWORKS = ['vitest', 'jest'] as const;

export type Platform = (typeof SUPPORTED_PLATFORMS)[number];
export type Category = (typeof SUPPORTED_CATEGORIES)[number];
export type Stack = (typeof SUPPORTED_STACKS)[keyof typeof SUPPORTED_STACKS][number];
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export type Database = (typeof SUPPORTED_DATABASES)[number];
export type Orm = (typeof SUPPORTED_ORMS)[number];
export type Architecture = (typeof SUPPORTED_ARCHITECTURES)[number];
export type PackageManager = (typeof SUPPORTED_PACKAGE_MANAGERS)[number];
export type TestFramework = (typeof SUPPORTED_TEST_FRAMEWORKS)[number];
