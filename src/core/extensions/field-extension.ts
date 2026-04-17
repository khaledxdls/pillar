import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourceFilePath } from '../../utils/resolve-resource-path.js';
import { assertSafeResourceName } from '../../utils/sanitize.js';
import { toPascalCase, findInterfaceBlock } from '../../utils/naming.js';

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
  const arch = config.project.architecture;
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  // Add to model/types
  const modelFile = path.join(projectRoot, resolveResourceFilePath(arch, resourceName, 'model', ext));
  const typesFile = path.join(projectRoot, resolveResourceFilePath(arch, resourceName, 'types', ext));

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
  const validatorFile = path.join(projectRoot, resolveResourceFilePath(arch, resourceName, 'validator', ext));
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

  assertSafeResourceName(resourceName);
  const pascalName = toPascalCase(resourceName);
  const block = findInterfaceBlock(content, pascalName);
  if (!block) return null;

  const newFields = fields
    .map((f) => {
      const opt = f.optional ? '?' : '';
      return `  ${f.name}${opt}: ${mapToTSType(f.type)};`;
    })
    .join('\n');

  const body = block.body.replace(/\s+$/, '');
  const separator = body.length === 0 ? '' : '\n';
  const updated =
    content.slice(0, block.openBrace + 1) +
    body +
    `${separator}\n${newFields}\n` +
    content.slice(block.closeBrace);

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
  const pascalName = toPascalCase(resourceName);

  const header = new RegExp(
    `export\\s+const\\s+create${pascalName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}Schema\\s*=\\s*z\\.object\\(\\s*\\{`,
  );
  const headerMatch = header.exec(content);
  if (!headerMatch) return null;

  const openBrace = headerMatch.index + headerMatch[0].length - 1;
  const closeBrace = findBalancedClose(content, openBrace);
  if (closeBrace === -1) return null;

  const body = content.slice(openBrace + 1, closeBrace).replace(/\s+$/, '');
  const newFields = fields
    .map((f) => `  ${f.name}: ${mapToZodType(f.type, f.optional)},`)
    .join('\n');

  const separator = body.length === 0 ? '' : '\n';
  const updated =
    content.slice(0, openBrace + 1) +
    body +
    `${separator}\n${newFields}\n` +
    content.slice(closeBrace);

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

/**
 * Scan `content` for the `}` that closes the `{` at `openIndex`, ignoring
 * braces inside strings/comments. Returns -1 if unbalanced.
 */
function findBalancedClose(content: string, openIndex: number): number {
  let depth = 0;
  let inString: '"' | "'" | '`' | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < content.length; i++) {
    const ch = content[i]!;
    const prev = i > 0 ? content[i - 1] : '';

    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '/' && prev === '*') inBlockComment = false; continue; }
    if (inString) { if (ch === inString && prev !== '\\') inString = null; continue; }

    if (ch === '/' && content[i + 1] === '/') { inLineComment = true; continue; }
    if (ch === '/' && content[i + 1] === '*') { inBlockComment = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
