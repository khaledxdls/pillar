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
      const content = generateSkeleton(fileName, purpose, this.context);
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
