import type { FileKind, GeneratorContext } from './types.js';
import type { Stack } from '../../utils/constants.js';

/**
 * Infer the kind of file from its name/extension.
 */
export function inferFileKind(fileName: string): FileKind {
  const lower = fileName.toLowerCase();

  if (lower.includes('.controller.')) return 'controller';
  if (lower.includes('.service.')) return 'service';
  if (lower.includes('.repository.') || lower.includes('.repo.')) return 'repository';
  if (lower.includes('.model.') || lower.includes('.entity.') || lower.includes('.schema.')) return 'model';
  if (lower.includes('.routes.') || lower.includes('.router.')) return 'routes';
  if (lower.includes('.validator.') || lower.includes('.validation.')) return 'validator';
  if (lower.includes('.types.') || lower.includes('.dto.') || lower.includes('.interface.')) return 'types';
  if (lower.includes('.test.') || lower.includes('.spec.')) return 'test';
  if (lower.includes('.middleware.')) return 'middleware';
  if (lower.includes('.util.') || lower.includes('.helper.') || lower.includes('.utils.')) return 'util';
  if (lower.endsWith('.tsx') || lower.endsWith('.jsx')) return 'component';

  return 'generic';
}

/**
 * Derive a PascalCase name from a file name.
 */
function toPascalCase(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('');
}

/**
 * Derive a camelCase name from a file name.
 */
function toCamelCase(name: string): string {
  const pascal = toPascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Extract the base name (without kind suffix and extension).
 * e.g., "user.controller.ts" → "user", "navbar.tsx" → "navbar"
 */
function extractBaseName(fileName: string): string {
  return fileName
    .replace(/\.(controller|service|repository|repo|model|entity|schema|routes|router|validator|validation|types|dto|interface|test|spec|middleware|util|helper|utils)\./i, '.')
    .replace(/\.[^.]+$/, '');
}

/**
 * Generate a smart skeleton for a given file based on its kind and stack.
 */
export function generateSkeleton(
  fileName: string,
  purpose: string,
  context?: Partial<GeneratorContext>,
): string {
  const kind = inferFileKind(fileName);
  const baseName = extractBaseName(fileName);
  const pascalName = toPascalCase(baseName);
  const camelName = toCamelCase(baseName);
  const isTS = fileName.endsWith('.ts') || fileName.endsWith('.tsx');
  const stack = context?.stack;

  const testFramework = context?.testFramework;

  const header = `// Purpose: ${purpose}\n\n`;

  const generator = SKELETON_GENERATORS[kind];
  return header + generator({ baseName, pascalName, camelName, isTS, stack, testFramework, purpose });
}

interface SkeletonParams {
  baseName: string;
  pascalName: string;
  camelName: string;
  isTS: boolean;
  stack?: Stack;
  testFramework?: string;
  purpose: string;
}

const SKELETON_GENERATORS: Record<FileKind, (p: SkeletonParams) => string> = {
  controller: ({ pascalName, camelName, isTS, stack }) => {
    if (stack === 'nestjs') {
      return [
        `import { Controller, Get, Post, Put, Delete, Param, Body } from '@nestjs/common';`,
        `import { ${pascalName}Service } from './${camelName}.service${isTS ? '' : '.js'}';`,
        '',
        `@Controller('${camelName}s')`,
        `export class ${pascalName}Controller {`,
        `  constructor(private readonly ${camelName}Service: ${pascalName}Service) {}`,
        '',
        '  @Get()',
        `  async findAll() {`,
        `    return this.${camelName}Service.findAll();`,
        '  }',
        '',
        `  @Get(':id')`,
        `  async findOne(@Param('id') id${isTS ? ': string' : ''}) {`,
        `    return this.${camelName}Service.findOne(id);`,
        '  }',
        '',
        '  @Post()',
        `  async create(@Body() data${isTS ? `: Create${pascalName}Dto` : ''}) {`,
        `    return this.${camelName}Service.create(data);`,
        '  }',
        '',
        `  @Put(':id')`,
        `  async update(@Param('id') id${isTS ? ': string' : ''}, @Body() data${isTS ? `: Update${pascalName}Dto` : ''}) {`,
        `    return this.${camelName}Service.update(id, data);`,
        '  }',
        '',
        `  @Delete(':id')`,
        `  async remove(@Param('id') id${isTS ? ': string' : ''}) {`,
        `    return this.${camelName}Service.remove(id);`,
        '  }',
        '}',
        '',
      ].join('\n');
    }

    // Express / Fastify / Hono
    return [
      `import { ${pascalName}Service } from './${camelName}.service.js';`,
      '',
      `const ${camelName}Service = new ${pascalName}Service();`,
      '',
      `export class ${pascalName}Controller {`,
      `  async findAll(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}) {`,
      `    const items = await ${camelName}Service.findAll();`,
      `    res.json(items);`,
      '  }',
      '',
      `  async findOne(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}) {`,
      `    const item = await ${camelName}Service.findOne(req.params.id);`,
      '    if (!item) {',
      '      res.status(404).json({ error: "Not found" });',
      '      return;',
      '    }',
      '    res.json(item);',
      '  }',
      '',
      `  async create(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}) {`,
      `    const item = await ${camelName}Service.create(req.body);`,
      '    res.status(201).json(item);',
      '  }',
      '',
      `  async update(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}) {`,
      `    const item = await ${camelName}Service.update(req.params.id, req.body);`,
      '    res.json(item);',
      '  }',
      '',
      `  async remove(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}) {`,
      `    await ${camelName}Service.remove(req.params.id);`,
      '    res.status(204).send();',
      '  }',
      '}',
      '',
    ].join('\n');
  },

  service: ({ pascalName, camelName, isTS }) => [
    `import { ${pascalName}Repository } from './${camelName}.repository.js';`,
    '',
    `const ${camelName}Repository = new ${pascalName}Repository();`,
    '',
    `export class ${pascalName}Service {`,
    `  async findAll() {`,
    `    return ${camelName}Repository.findAll();`,
    '  }',
    '',
    `  async findOne(id${isTS ? ': string' : ''}) {`,
    `    return ${camelName}Repository.findOne(id);`,
    '  }',
    '',
    `  async create(data${isTS ? `: Partial<${pascalName}>` : ''}) {`,
    `    return ${camelName}Repository.create(data);`,
    '  }',
    '',
    `  async update(id${isTS ? ': string' : ''}, data${isTS ? `: Partial<${pascalName}>` : ''}) {`,
    `    return ${camelName}Repository.update(id, data);`,
    '  }',
    '',
    `  async remove(id${isTS ? ': string' : ''}) {`,
    `    return ${camelName}Repository.remove(id);`,
    '  }',
    '}',
    '',
  ].join('\n'),

  repository: ({ pascalName, isTS }) => [
    `export class ${pascalName}Repository {`,
    `  async findAll()${isTS ? `: Promise<${pascalName}[]>` : ''} {`,
    '    // TODO: implement database query',
    '    throw new Error("Not implemented");',
    '  }',
    '',
    `  async findOne(id${isTS ? ': string' : ''})${isTS ? `: Promise<${pascalName} | null>` : ''} {`,
    '    // TODO: implement database query',
    '    throw new Error("Not implemented");',
    '  }',
    '',
    `  async create(data${isTS ? `: Partial<${pascalName}>` : ''})${isTS ? `: Promise<${pascalName}>` : ''} {`,
    '    // TODO: implement database query',
    '    throw new Error("Not implemented");',
    '  }',
    '',
    `  async update(id${isTS ? ': string' : ''}, data${isTS ? `: Partial<${pascalName}>` : ''})${isTS ? `: Promise<${pascalName}>` : ''} {`,
    '    // TODO: implement database query',
    '    throw new Error("Not implemented");',
    '  }',
    '',
    `  async remove(id${isTS ? ': string' : ''})${isTS ? ': Promise<void>' : ''} {`,
    '    // TODO: implement database query',
    '    throw new Error("Not implemented");',
    '  }',
    '}',
    '',
  ].join('\n'),

  model: ({ pascalName, isTS }) => {
    if (!isTS) {
      return [
        `/**`,
        ` * @typedef {Object} ${pascalName}`,
        ` * @property {string} id`,
        ` * @property {Date} createdAt`,
        ` * @property {Date} updatedAt`,
        ` */`,
        '',
      ].join('\n');
    }
    return [
      `export interface ${pascalName} {`,
      '  id: string;',
      '  createdAt: Date;',
      '  updatedAt: Date;',
      '}',
      '',
      `export interface Create${pascalName}Input {`,
      `  // TODO: define creation fields`,
      '}',
      '',
      `export interface Update${pascalName}Input {`,
      `  // TODO: define update fields`,
      '}',
      '',
    ].join('\n');
  },

  routes: ({ pascalName, camelName, isTS, stack }) => {
    if (stack === 'fastify') {
      return [
        `import type { FastifyInstance } from 'fastify';`,
        `import { ${pascalName}Controller } from './${camelName}.controller.js';`,
        '',
        `const controller = new ${pascalName}Controller();`,
        '',
        `export async function ${camelName}Routes(app${isTS ? ': FastifyInstance' : ''}) {`,
        `  app.get('/${camelName}s', (req, res) => controller.findAll(req, res));`,
        `  app.get('/${camelName}s/:id', (req, res) => controller.findOne(req, res));`,
        `  app.post('/${camelName}s', (req, res) => controller.create(req, res));`,
        `  app.put('/${camelName}s/:id', (req, res) => controller.update(req, res));`,
        `  app.delete('/${camelName}s/:id', (req, res) => controller.remove(req, res));`,
        '}',
        '',
      ].join('\n');
    }
    if (stack === 'hono') {
      return [
        `import { Hono } from 'hono';`,
        `import { ${pascalName}Controller } from './${camelName}.controller.js';`,
        '',
        `const controller = new ${pascalName}Controller();`,
        `export const ${camelName}Routes = new Hono();`,
        '',
        `${camelName}Routes.get('/', (c) => controller.findAll(c));`,
        `${camelName}Routes.get('/:id', (c) => controller.findOne(c));`,
        `${camelName}Routes.post('/', (c) => controller.create(c));`,
        `${camelName}Routes.put('/:id', (c) => controller.update(c));`,
        `${camelName}Routes.delete('/:id', (c) => controller.remove(c));`,
        '',
      ].join('\n');
    }
    // Express (default)
    return [
      `import { Router } from 'express';`,
      `import { ${pascalName}Controller } from './${camelName}.controller.js';`,
      '',
      `const router = Router();`,
      `const controller = new ${pascalName}Controller();`,
      '',
      `router.get('/', (req, res) => controller.findAll(req, res));`,
      `router.get('/:id', (req, res) => controller.findOne(req, res));`,
      `router.post('/', (req, res) => controller.create(req, res));`,
      `router.put('/:id', (req, res) => controller.update(req, res));`,
      `router.delete('/:id', (req, res) => controller.remove(req, res));`,
      '',
      `export { router as ${camelName}Router };`,
      '',
    ].join('\n');
  },

  validator: ({ pascalName, isTS }) => {
    if (!isTS) {
      return [
        `export function validateCreate${pascalName}(data) {`,
        '  const errors = [];',
        '  // TODO: add validation rules',
        '  return { valid: errors.length === 0, errors };',
        '}',
        '',
        `export function validateUpdate${pascalName}(data) {`,
        '  const errors = [];',
        '  // TODO: add validation rules',
        '  return { valid: errors.length === 0, errors };',
        '}',
        '',
      ].join('\n');
    }
    return [
      `import { z } from 'zod';`,
      '',
      `export const create${pascalName}Schema = z.object({`,
      '  // TODO: define creation schema',
      '});',
      '',
      `export const update${pascalName}Schema = z.object({`,
      '  // TODO: define update schema',
      '});',
      '',
      `export type Create${pascalName}Input = z.infer<typeof create${pascalName}Schema>;`,
      `export type Update${pascalName}Input = z.infer<typeof update${pascalName}Schema>;`,
      '',
    ].join('\n');
  },

  types: ({ pascalName }) => [
    `export interface ${pascalName} {`,
    '  id: string;',
    '  createdAt: Date;',
    '  updatedAt: Date;',
    '}',
    '',
    `export interface ${pascalName}ListResponse {`,
    `  data: ${pascalName}[];`,
    '  total: number;',
    '}',
    '',
  ].join('\n'),

  test: ({ pascalName, camelName, isTS, testFramework }) => {
    const importSource = testFramework === 'jest' ? '@jest/globals' : 'vitest';
    return [
      `import { describe, it, expect, beforeEach } from '${importSource}';`,
      `import { ${pascalName}Service } from './${camelName}.service.js';`,
      '',
      `describe('${pascalName}Service', () => {`,
      `  let service${isTS ? `: ${pascalName}Service` : ''};`,
      '',
      '  beforeEach(() => {',
      `    service = new ${pascalName}Service();`,
      '  });',
      '',
      '  describe("findAll", () => {',
      '    it("should return all items", async () => {',
      '      // TODO: implement test',
      '      expect(service).toBeDefined();',
      '    });',
      '  });',
      '',
      '  describe("findOne", () => {',
      '    it("should return a single item by id", async () => {',
      '      // TODO: implement test',
      '      expect(service).toBeDefined();',
      '    });',
      '  });',
      '',
      '  describe("create", () => {',
      '    it("should create a new item", async () => {',
      '      // TODO: implement test',
      '      expect(service).toBeDefined();',
      '    });',
      '  });',
      '});',
      '',
    ].join('\n');
  },

  component: ({ pascalName }) => [
    `export function ${pascalName}() {`,
    '  return (',
    `    <div>`,
    `      {/* TODO: implement ${pascalName} */}`,
    `    </div>`,
    '  );',
    '}',
    '',
  ].join('\n'),

  middleware: ({ pascalName, isTS }) => {
    return [
      `export function ${pascalName.charAt(0).toLowerCase() + pascalName.slice(1)}Middleware(req${isTS ? ': Request' : ''}, res${isTS ? ': Response' : ''}, next${isTS ? ': () => void' : ''}) {`,
      '  // TODO: implement middleware logic',
      '  next();',
      '}',
      '',
    ].join('\n');
  },

  util: ({ }) => [
    '// TODO: implement utility functions',
    '',
  ].join('\n'),

  generic: ({ }) => '',
};
