import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile, GeneratorContext, ResourceField } from './types.js';
import { generateSkeleton } from './skeleton.js';
import { resolveResourcePath } from '../../utils/resolve-resource-path.js';

interface ResourceOptions {
  name: string;
  fields?: ResourceField[];
  skipTest?: boolean;
  only?: string[];
}

type ResourceFileSpec = {
  suffix: string;
  purpose: (name: string) => string;
  kind: string;
};

const RESOURCE_FILES: ResourceFileSpec[] = [
  { suffix: 'model', purpose: (n: string) => `Data model and type definitions for ${n}`, kind: 'model' },
  { suffix: 'repository', purpose: (n: string) => `Database queries and data access for ${n}`, kind: 'repository' },
  { suffix: 'service', purpose: (n: string) => `Business logic for ${n}`, kind: 'service' },
  { suffix: 'controller', purpose: (n: string) => `HTTP request handlers for ${n}`, kind: 'controller' },
  { suffix: 'routes', purpose: (n: string) => `Route definitions for ${n} endpoints`, kind: 'routes' },
  { suffix: 'validator', purpose: (n: string) => `Input validation schemas for ${n}`, kind: 'validator' },
  { suffix: 'types', purpose: (n: string) => `TypeScript interfaces and types for ${n}`, kind: 'types' },
  { suffix: 'test', purpose: (n: string) => `Unit and integration tests for ${n}`, kind: 'test' },
];

const LAYERED_DIRS: Record<string, string> = {
  model: 'models',
  repository: 'repositories',
  service: 'services',
  controller: 'controllers',
  routes: 'routes',
  validator: 'validators',
  types: 'types',
  test: 'tests',
};

export class ResourceGenerator {
  private readonly context: GeneratorContext;

  constructor(config: PillarConfig) {
    this.context = {
      projectName: config.project.name,
      stack: config.project.stack,
      language: config.project.language,
      architecture: config.project.architecture,
      database: config.database.type,
      orm: config.database.orm,
      testFramework: config.generation.testFramework,
    };
  }

  /**
   * Generate all files for a resource (feature).
   */
  generate(options: ResourceOptions): GeneratedFile[] {
    const { name, skipTest, only } = options;
    const ext = this.context.language === 'typescript' ? 'ts' : 'js';
    const basePath = resolveResourcePath(this.context.architecture, name);

    let specs = RESOURCE_FILES;

    if (skipTest) {
      specs = specs.filter((s) => s.suffix !== 'test');
    }

    // In NestJS, routes are handled by decorators, no separate routes file
    if (this.context.stack === 'nestjs') {
      specs = specs.filter((s) => s.suffix !== 'routes');
    }

    // JS projects don't need a types file
    if (this.context.language === 'javascript') {
      specs = specs.filter((s) => s.suffix !== 'types');
    }

    if (only && only.length > 0) {
      specs = specs.filter((s) => only.includes(s.suffix));
    }

    return specs.map((spec) => {
      const fileName = `${name}.${spec.suffix}.${ext}`;
      const purpose = spec.purpose(name);
      let content = generateSkeleton(fileName, purpose, this.context);

      // Inject fields into model, types, and validator files
      if (options.fields && options.fields.length > 0) {
        content = injectFieldsIntoContent(content, options.fields, spec.suffix, name);
      }

      const filePath = this.context.architecture === 'layered'
        ? `src/${LAYERED_DIRS[spec.suffix] ?? ''}/${fileName}`
        : `${basePath}/${fileName}`;

      return {
        relativePath: filePath,
        content,
        purpose,
      };
    });
  }

}

const TS_TYPE_MAP: Record<string, string> = {
  string: 'string', number: 'number', boolean: 'boolean',
  date: 'Date', int: 'number', float: 'number', uuid: 'string',
  json: 'Record<string, unknown>',
};

const ZOD_TYPE_MAP: Record<string, string> = {
  string: 'z.string()', number: 'z.number()', boolean: 'z.boolean()',
  date: 'z.date()', int: 'z.number().int()', float: 'z.number()',
  uuid: 'z.string().uuid()', json: 'z.record(z.unknown())',
};

/**
 * Inject fields into generated skeleton content for model, types, and validator files.
 */
function injectFieldsIntoContent(
  content: string,
  fields: ResourceField[],
  suffix: string,
  resourceName: string,
): string {
  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);

  if (suffix === 'model') {
    // Inject fields into the main interface before the closing }
    const fieldLines = fields
      .map((f) => `  ${f.name}${f.required === false ? '?' : ''}: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');

    // Insert fields into the main interface
    content = content.replace(
      new RegExp(`(export\\s+interface\\s+${pascalName}\\s*\\{[^}]*?)(\\n})`),
      `$1\n${fieldLines}\n}`,
    );

    // Replace TODO in CreateInput
    const createFields = fields
      .map((f) => `  ${f.name}${f.required === false ? '?' : ''}: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');
    content = content.replace(
      /  \/\/ TODO: define creation fields/,
      createFields,
    );

    // Replace TODO in UpdateInput (all optional)
    const updateFields = fields
      .map((f) => `  ${f.name}?: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');
    content = content.replace(
      /  \/\/ TODO: define update fields/,
      updateFields,
    );
  }

  if (suffix === 'types') {
    // Inject fields into the main interface
    const fieldLines = fields
      .map((f) => `  ${f.name}${f.required === false ? '?' : ''}: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');
    content = content.replace(
      new RegExp(`(export\\s+interface\\s+${pascalName}\\s*\\{[^}]*?)(\\n})`),
      `$1\n${fieldLines}\n}`,
    );
  }

  if (suffix === 'validator') {
    // Replace TODO in create schema with Zod fields
    const zodFields = fields
      .filter((f) => f.required !== false)
      .map((f) => `  ${f.name}: ${ZOD_TYPE_MAP[f.type.toLowerCase()] ?? 'z.string()'},`)
      .join('\n');
    content = content.replace(
      /  \/\/ TODO: define creation schema/,
      zodFields,
    );

    // Replace TODO in update schema with optional Zod fields
    const zodUpdateFields = fields
      .map((f) => `  ${f.name}: ${(ZOD_TYPE_MAP[f.type.toLowerCase()] ?? 'z.string()') + '.optional()'},`)
      .join('\n');
    content = content.replace(
      /  \/\/ TODO: define update schema/,
      zodUpdateFields,
    );
  }

  return content;
}
