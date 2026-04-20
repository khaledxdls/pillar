import type { PillarConfig } from '../config/index.js';
import type { GeneratedFile, GeneratorContext, ResourceField } from './types.js';
import { generateSkeleton } from './skeleton.js';
import { resolveResourcePath, LAYERED_DIRS } from '../../utils/resolve-resource-path.js';
import { toPascalCase, toCamelCase, pluralizeResource, findInterfaceBlock } from '../../utils/naming.js';

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

    // Next.js (App Router) has a fundamentally different HTTP surface:
    // route handlers live under `src/app/api/<plural>/route.ts` and export
    // HTTP-verb functions, not Express-style controllers/routers. Emitting
    // the generic controller/routes pair here generated code that imported
    // `express` (not a dep in a Next.js project) and failed `tsc --noEmit`
    // — the E2E smoke harness caught this. A Next.js-specific route
    // handler is emitted below instead.
    if (this.context.stack === 'nextjs') {
      specs = specs.filter((s) => s.suffix !== 'controller' && s.suffix !== 'routes');
    }

    // JS projects don't need a types file
    if (this.context.language === 'javascript') {
      specs = specs.filter((s) => s.suffix !== 'types');
    }

    if (only && only.length > 0) {
      specs = specs.filter((s) => only.includes(s.suffix));
    }

    const files: GeneratedFile[] = specs.map((spec) => {
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

    // Next.js App Router: emit a route handler wired to the generated
    // service. Depth-2 paths (`/api/<plural>/[id]/route.ts`) are not
    // emitted by default — the user can add them via `pillar add endpoint`
    // once route-handler extension is wired up. This keeps the smoke
    // baseline minimal but functional.
    if (this.context.stack === 'nextjs' && (!only || only.includes('controller') || only.includes('routes'))) {
      files.push(generateNextRouteHandler({
        name,
        ext,
        basePath,
        architecture: this.context.architecture,
      }));
    }

    return files;
  }

}

function generateNextRouteHandler(opts: {
  name: string;
  ext: string;
  basePath: string;
  architecture: GeneratorContext['architecture'];
}): GeneratedFile {
  const pascalName = toPascalCase(opts.name);
  const camelName = toCamelCase(opts.name);
  const plural = pluralizeResource(camelName);

  // Resolve sibling-file paths (service, validator) for the chosen
  // architecture. Next.js tsconfig maps `@/*` → `src/*`, so every path here
  // is anchored at `src/` without the `src/` prefix.
  const importFor = (suffix: string): string => {
    if (opts.architecture === 'layered') {
      const dir = LAYERED_DIRS[suffix] ?? suffix;
      return `@/${dir}/${camelName}.${suffix}.js`;
    }
    if (opts.architecture === 'modular') {
      return `@/modules/${opts.name}/${camelName}.${suffix}.js`;
    }
    return `@/features/${opts.name}/${camelName}.${suffix}.js`;
  };

  const content = [
    `// Purpose: Next.js App Router handler for /${plural}`,
    '',
    `import { NextResponse } from 'next/server';`,
    `import { ${pascalName}Service } from '${importFor('service')}';`,
    `import { create${pascalName}Schema } from '${importFor('validator')}';`,
    '',
    `const ${camelName}Service = new ${pascalName}Service();`,
    '',
    'export async function GET() {',
    `  const items = await ${camelName}Service.findAll();`,
    '  return NextResponse.json(items);',
    '}',
    '',
    'export async function POST(request: Request) {',
    '  const body = await request.json();',
    `  const parsed = create${pascalName}Schema.safeParse(body);`,
    '  if (!parsed.success) {',
    '    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });',
    '  }',
    `  const item = await ${camelName}Service.create(parsed.data);`,
    '  return NextResponse.json(item, { status: 201 });',
    '}',
    '',
  ].join('\n');

  return {
    relativePath: `src/app/api/${plural}/route.${opts.ext}`,
    content,
    purpose: `Next.js App Router handler for /${plural}`,
  };
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
  const pascalName = toPascalCase(resourceName);

  if (suffix === 'model') {
    const fieldLines = fields
      .map((f) => `  ${f.name}${f.required === false ? '?' : ''}: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');

    content = injectIntoInterface(content, pascalName, fieldLines);

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
    const fieldLines = fields
      .map((f) => `  ${f.name}${f.required === false ? '?' : ''}: ${TS_TYPE_MAP[f.type.toLowerCase()] ?? 'string'};`)
      .join('\n');
    content = injectIntoInterface(content, pascalName, fieldLines);
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

function injectIntoInterface(content: string, pascalName: string, fieldLines: string): string {
  const block = findInterfaceBlock(content, pascalName);
  if (!block) return content;
  const body = block.body.replace(/\s+$/, '');
  const separator = body.length === 0 ? '' : '\n';
  return (
    content.slice(0, block.openBrace + 1) +
    body +
    `${separator}\n${fieldLines}\n` +
    content.slice(block.closeBrace)
  );
}
