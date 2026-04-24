import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { PlanBuilder, PlanExecutor } from '../plan/index.js';
import type { Plan } from '../plan/index.js';
import { resolveResourceFilePath } from '../../utils/resolve-resource-path.js';
import { assertSafeResourceName } from '../../utils/sanitize.js';
import { toPascalCase, findInterfaceBlock } from '../../utils/naming.js';
import { addFieldsToInterface, addFieldsToZodObjectSchema } from '../ast/index.js';

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
 * Compute the Plan for adding fields to a resource. No filesystem writes.
 *
 * This is the single source of truth for what "add field" does; the write
 * path is a thin wrapper (`addFieldToResource`) that executes this plan,
 * and the preview path renders it directly.
 */
export async function planFieldExtension(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  fieldDefs: FieldDefinition[],
  command: string,
): Promise<Plan> {
  assertSafeResourceName(resourceName);
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const arch = config.project.architecture;
  const builder = new PlanBuilder(projectRoot, command);

  if (config.project.language === 'typescript') {
    await planInterfaceEdit(builder, projectRoot, resolveResourceFilePath(arch, resourceName, 'types', ext), resourceName, fieldDefs);
    await planInterfaceEdit(builder, projectRoot, resolveResourceFilePath(arch, resourceName, 'model', ext), resourceName, fieldDefs);
  }

  await planValidatorEdit(builder, projectRoot, resolveResourceFilePath(arch, resourceName, 'validator', ext), resourceName, fieldDefs);

  return builder.build();
}

/**
 * Apply fields to a resource. Plan-first internally so both the write
 * path and `--preview` share one transform pipeline.
 */
export async function addFieldToResource(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  fieldDefs: FieldDefinition[],
): Promise<FieldExtensionResult> {
  const plan = await planFieldExtension(projectRoot, config, resourceName, fieldDefs, `add field ${resourceName}`);
  const { operations, touched } = await new PlanExecutor(projectRoot).execute(plan);
  return { operations, modifiedFiles: touched };
}

async function planInterfaceEdit(
  builder: PlanBuilder,
  projectRoot: string,
  relativePath: string,
  resourceName: string,
  fields: FieldDefinition[],
): Promise<void> {
  const full = path.join(projectRoot, relativePath);
  if (!(await fs.pathExists(full))) return;

  const content = await fs.readFile(full, 'utf-8');
  const pascalName = toPascalCase(resourceName);

  // Primary path: AST-based via ts-morph. Falls back to balanced-brace
  // splicing when ts-morph can't locate the interface (malformed source,
  // mid-edit partial files) so user input is never silently dropped.
  const astResult = addFieldsToInterface(
    content,
    pascalName,
    fields.map((f) => ({ name: f.name, type: mapToTSType(f.type), optional: f.optional })),
  );

  let updated: string;
  if (astResult !== null) {
    updated = astResult;
  } else {
    const block = findInterfaceBlock(content, pascalName);
    if (!block) return;
    const fieldLines = fields
      .map((f) => `  ${f.name}${f.optional ? '?' : ''}: ${mapToTSType(f.type)};`)
      .join('\n');
    const body = block.body.replace(/\s+$/, '');
    const separator = body.length === 0 ? '' : '\n';
    updated =
      content.slice(0, block.openBrace + 1) +
      body +
      `${separator}\n${fieldLines}\n` +
      content.slice(block.closeBrace);
  }

  if (updated === content) return;
  await builder.modify(relativePath, updated, `add fields to ${pascalName}`);
}

async function planValidatorEdit(
  builder: PlanBuilder,
  projectRoot: string,
  relativePath: string,
  resourceName: string,
  fields: FieldDefinition[],
): Promise<void> {
  const full = path.join(projectRoot, relativePath);
  if (!(await fs.pathExists(full))) return;

  const content = await fs.readFile(full, 'utf-8');
  const pascalName = toPascalCase(resourceName);
  const schemaVar = `create${pascalName}Schema`;

  const astResult = addFieldsToZodObjectSchema(
    content,
    schemaVar,
    fields.map((f) => ({ name: f.name, expression: mapToZodType(f.type, f.optional) })),
  );

  let updated: string;
  if (astResult !== null) {
    updated = astResult;
  } else {
    const header = new RegExp(
      `export\\s+const\\s+${escapeForRe(schemaVar)}\\s*=\\s*z\\.object\\(\\s*\\{`,
    );
    const headerMatch = header.exec(content);
    if (!headerMatch) return;

    const openBrace = headerMatch.index + headerMatch[0].length - 1;
    const closeBrace = findBalancedClose(content, openBrace);
    if (closeBrace === -1) return;

    const body = content.slice(openBrace + 1, closeBrace).replace(/\s+$/, '');
    const newFields = fields
      .map((f) => `  ${f.name}: ${mapToZodType(f.type, f.optional)},`)
      .join('\n');
    const separator = body.length === 0 ? '' : '\n';
    updated =
      content.slice(0, openBrace + 1) +
      body +
      `${separator}\n${newFields}\n` +
      content.slice(closeBrace);
  }

  if (updated === content) return;
  await builder.modify(relativePath, updated, `add fields to ${schemaVar}`);
}

function escapeForRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
