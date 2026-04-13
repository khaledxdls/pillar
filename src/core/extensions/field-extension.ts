import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourcePath } from '../../utils/resolve-resource-path.js';
import { escapeRegex, assertSafeResourceName } from '../../utils/sanitize.js';

interface FieldDefinition {
  name: string;
  type: string;
  optional: boolean;
  unique: boolean;
}

interface FieldExtensionResult {
  operations: FileOperation[];
  modifiedFiles: string[];
}

/**
 * Parse a field string like "email:string:unique" into a FieldDefinition.
 */
export function parseFieldDef(raw: string): FieldDefinition {
  const parts = raw.split(':');
  return {
    name: parts[0] ?? raw,
    type: parts[1] ?? 'string',
    optional: parts.includes('optional'),
    unique: parts.includes('unique'),
  };
}

/**
 * Add a field to a resource's model, types, and validator files.
 */
export async function addFieldToResource(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  fieldDefs: FieldDefinition[],
): Promise<FieldExtensionResult> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const basePath = resolveResourcePath(config.project.architecture, resourceName);
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  // Add to model/types
  const modelFile = path.join(projectRoot, basePath, `${resourceName}.model.${ext}`);
  const typesFile = path.join(projectRoot, basePath, `${resourceName}.types.${ext}`);

  if (config.project.language === 'typescript') {
    // Update types file
    if (await fs.pathExists(typesFile)) {
      const result = await injectFieldsIntoInterface(typesFile, resourceName, fieldDefs);
      if (result) {
        operations.push(result.operation);
        modifiedFiles.push(path.relative(projectRoot, typesFile));
      }
    }

    // Update model file
    if (await fs.pathExists(modelFile)) {
      const result = await injectFieldsIntoInterface(modelFile, resourceName, fieldDefs);
      if (result) {
        operations.push(result.operation);
        modifiedFiles.push(path.relative(projectRoot, modelFile));
      }
    }
  }

  // Update validator (Zod schema)
  const validatorFile = path.join(projectRoot, basePath, `${resourceName}.validator.${ext}`);
  if (await fs.pathExists(validatorFile)) {
    const result = await injectFieldsIntoZodSchema(validatorFile, resourceName, fieldDefs);
    if (result) {
      operations.push(result.operation);
      modifiedFiles.push(path.relative(projectRoot, validatorFile));
    }
  }

  return { operations, modifiedFiles };
}

async function injectFieldsIntoInterface(
  filePath: string,
  resourceName: string,
  fields: FieldDefinition[],
): Promise<{ operation: FileOperation } | null> {
  const content = await fs.readFile(filePath, 'utf-8');
  const previousContent = content;

  // Find the main interface (PascalCase of resource name)
  assertSafeResourceName(resourceName);
  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);
  const interfacePattern = new RegExp(
    `(export\\s+interface\\s+${escapeRegex(pascalName)}\\s*\\{[^}]*?)(\\n})`,
  );
  const match = content.match(interfacePattern);
  if (!match) return null;

  const newFields = fields
    .map((f) => {
      const opt = f.optional ? '?' : '';
      return `  ${f.name}${opt}: ${mapToTSType(f.type)};`;
    })
    .join('\n');

  const updated = content.replace(
    interfacePattern,
    `$1\n${newFields}\n}`,
  );

  if (updated === content) return null;

  await fs.writeFile(filePath, updated, 'utf-8');
  return {
    operation: {
      type: 'modify',
      path: filePath,
      previousContent,
    },
  };
}

async function injectFieldsIntoZodSchema(
  filePath: string,
  resourceName: string,
  fields: FieldDefinition[],
): Promise<{ operation: FileOperation } | null> {
  const content = await fs.readFile(filePath, 'utf-8');
  const previousContent = content;

  assertSafeResourceName(resourceName);
  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);

  // Find `create<Name>Schema = z.object({...})`
  const schemaPattern = new RegExp(
    `(export\\s+const\\s+create${escapeRegex(pascalName)}Schema\\s*=\\s*z\\.object\\(\\{[^}]*?)(\\n\\}\\))`,
  );
  const match = content.match(schemaPattern);
  if (!match) return null;

  const newFields = fields
    .map((f) => {
      const zodType = mapToZodType(f.type, f.optional);
      return `  ${f.name}: ${zodType},`;
    })
    .join('\n');

  const updated = content.replace(
    schemaPattern,
    `$1\n${newFields}\n})`,
  );

  if (updated === content) return null;

  await fs.writeFile(filePath, updated, 'utf-8');
  return {
    operation: {
      type: 'modify',
      path: filePath,
      previousContent,
    },
  };
}

function mapToTSType(type: string): string {
  const map: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    date: 'Date',
    int: 'number',
    float: 'number',
    uuid: 'string',
    json: 'Record<string, unknown>',
  };
  return map[type.toLowerCase()] ?? 'string';
}

function mapToZodType(type: string, optional: boolean): string {
  const map: Record<string, string> = {
    string: 'z.string()',
    number: 'z.number()',
    boolean: 'z.boolean()',
    date: 'z.date()',
    int: 'z.number().int()',
    float: 'z.number()',
    uuid: 'z.string().uuid()',
    json: 'z.record(z.unknown())',
  };
  const base = map[type.toLowerCase()] ?? 'z.string()';
  return optional ? `${base}.optional()` : base;
}
