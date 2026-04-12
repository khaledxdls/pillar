import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { AIGenerationPlan, AIFileAction } from './types.js';
import type { FileOperation } from '../history/types.js';
import { generateSkeleton } from '../generator/skeleton.js';

interface ExecutionResult {
  operations: FileOperation[];
  createdFiles: string[];
  modifiedFiles: string[];
}

/**
 * Execute an AI generation plan by creating/modifying files.
 *
 * For "create" actions:
 *   - If the AI provided `content`, use it directly (custom/non-standard files).
 *   - Otherwise, use the skeleton engine for deterministic CRUD scaffolds.
 *
 * For "modify" actions:
 *   - Inject `imports` at the top of the file.
 *   - Inject `registrations` before the TODO comment or export.
 *   - Inject `methods` into the last class body.
 */
export async function executePlan(
  projectRoot: string,
  config: PillarConfig,
  plan: AIGenerationPlan,
): Promise<ExecutionResult> {
  const operations: FileOperation[] = [];
  const createdFiles: string[] = [];
  const modifiedFiles: string[] = [];

  for (const action of plan.create) {
    const fullPath = path.join(projectRoot, action.path);
    if (await fs.pathExists(fullPath)) continue;

    const content = generateFileFromAction(action, config);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    operations.push({ type: 'create', path: action.path });
    createdFiles.push(action.path);
  }

  for (const action of plan.modify) {
    const fullPath = path.join(projectRoot, action.path);
    if (!(await fs.pathExists(fullPath))) continue;

    const previousContent = await fs.readFile(fullPath, 'utf-8');
    const updated = applyModification(previousContent, action, config);

    if (updated !== previousContent) {
      await fs.writeFile(fullPath, updated, 'utf-8');
      operations.push({ type: 'modify', path: action.path, previousContent });
      modifiedFiles.push(action.path);
    }
  }

  return { operations, createdFiles, modifiedFiles };
}

/**
 * Generate file content from an AI action.
 * Uses AI-provided content for custom files, skeleton engine for standard CRUD.
 */
function generateFileFromAction(action: AIFileAction, config: PillarConfig): string {
  // If AI provided custom content, use it with a purpose header
  if (action.content) {
    const header = `// Purpose: ${action.purpose}\n\n`;
    return header + action.content;
  }

  const fileName = path.basename(action.path);

  let content = generateSkeleton(fileName, action.purpose, {
    stack: config.project.stack,
    language: config.project.language,
    testFramework: config.generation.testFramework,
  });

  // If the AI specified fields, inject them into interfaces/models
  if (action.fields && action.fields.length > 0) {
    const isTS = config.project.language === 'typescript';
    if (isTS && (action.kind === 'model' || action.kind === 'types')) {
      content = injectFields(content, action.fields);
    }
  }

  return content;
}

/**
 * Apply a modification action to existing file content.
 * Handles three types of modifications:
 *   1. imports — added at the top after existing imports
 *   2. registrations — added before TODO/export markers (for app.ts/server.ts)
 *   3. methods — injected into the last class body
 */
function applyModification(
  content: string,
  action: AIFileAction,
  config: PillarConfig,
): string {
  let updated = content;

  // 1. Add imports at the top of the file
  if (action.imports && action.imports.length > 0) {
    updated = injectImports(updated, action.imports);
  }

  // 2. Add route registrations (for app.ts / server.ts style files)
  if (action.registrations && action.registrations.length > 0) {
    updated = injectRegistrations(updated, action.registrations);
  }

  // 3. Add methods to a class (for controller/service files)
  if (action.methods && action.methods.length > 0) {
    updated = injectMethods(updated, action.methods, action.kind, config);
  }

  return updated;
}

/**
 * Insert import statements after the last existing import line.
 */
function injectImports(content: string, imports: string[]): string {
  const lines = content.split('\n');
  let lastImportIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith('import ') || line.startsWith('import{')) {
      lastImportIndex = i;
    }
    // Stop searching after we pass the import block
    if (lastImportIndex >= 0 && line !== '' && !line.startsWith('import') && !line.startsWith('//')) {
      break;
    }
  }

  const newImports = imports.filter((imp) => !content.includes(imp));
  if (newImports.length === 0) return content;

  const insertAt = lastImportIndex >= 0 ? lastImportIndex + 1 : 0;
  lines.splice(insertAt, 0, ...newImports);

  return lines.join('\n');
}

/**
 * Insert route registration lines before the TODO comment or last export.
 * Targets patterns like: // TODO: register routes, export { app }
 */
function injectRegistrations(content: string, registrations: string[]): string {
  const newRegs = registrations.filter((reg) => !content.includes(reg));
  if (newRegs.length === 0) return content;

  const regBlock = '\n' + newRegs.join('\n') + '\n';

  // Strategy 1: Insert before "// TODO: register" comments
  const todoMatch = content.match(/^[ \t]*\/\/\s*TODO:?\s*register.*$/m);
  if (todoMatch && todoMatch.index !== undefined) {
    return content.slice(0, todoMatch.index) + regBlock + '\n' + content.slice(todoMatch.index);
  }

  // Strategy 2: Insert before `export { app` or `export default app`
  const exportMatch = content.match(/^(export\s+\{[^}]*app|export\s+default\s+app)/m);
  if (exportMatch && exportMatch.index !== undefined) {
    return content.slice(0, exportMatch.index) + regBlock + '\n' + content.slice(exportMatch.index);
  }

  // Strategy 3: Insert before the last `export`
  const lastExportIndex = content.lastIndexOf('\nexport');
  if (lastExportIndex !== -1) {
    return content.slice(0, lastExportIndex) + regBlock + content.slice(lastExportIndex);
  }

  // Fallback: append before the last line
  return content + regBlock;
}

/**
 * Inject methods into the last class body.
 * Only targets actual class declarations, not export blocks.
 */
function injectMethods(
  content: string,
  methods: Array<{ name: string; description: string }>,
  kind: string | undefined,
  config: PillarConfig,
): string {
  let updated = content;
  const isTS = config.project.language === 'typescript';

  // Find the last class closing brace by matching `class ... {` and tracking braces
  const classEnd = findLastClassClosingBrace(updated);
  if (classEnd === -1) return updated;

  for (const method of methods) {
    if (updated.includes(`${method.name}(`)) continue;

    const reqType = isTS ? 'req: Request' : 'req';
    const resType = isTS ? 'res: Response' : 'res';

    let newMethod: string;
    if (kind === 'controller') {
      newMethod = [
        '',
        `  // ${method.description}`,
        `  async ${method.name}(${reqType}, ${resType}) {`,
        `    // TODO: implement`,
        `    res.json({ message: "not implemented" });`,
        `  }`,
      ].join('\n');
    } else {
      newMethod = [
        '',
        `  // ${method.description}`,
        `  async ${method.name}() {`,
        `    // TODO: implement`,
        `    throw new Error("Not implemented");`,
        `  }`,
      ].join('\n');
    }

    const insertAt = findLastClassClosingBrace(updated);
    if (insertAt === -1) break;
    updated = updated.slice(0, insertAt) + newMethod + '\n' + updated.slice(insertAt);
  }

  return updated;
}

/**
 * Find the position of the closing `}` of the last class declaration.
 * This avoids injecting into export blocks, object literals, or functions.
 */
function findLastClassClosingBrace(content: string): number {
  // Find all class declarations
  const classRegex = /\bclass\s+\w+/g;
  let lastClassStart = -1;
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(content)) !== null) {
    lastClassStart = match.index;
  }

  if (lastClassStart === -1) return -1;

  // From the class start, find the opening `{` and track brace depth
  const openBrace = content.indexOf('{', lastClassStart);
  if (openBrace === -1) return -1;

  let depth = 1;
  for (let i = openBrace + 1; i < content.length; i++) {
    if (content[i] === '{') depth++;
    if (content[i] === '}') depth--;
    if (depth === 0) return i;
  }

  return -1;
}

function injectFields(content: string, fields: Array<{ name: string; type: string }>): string {
  const interfaceRegex = /(export\s+interface\s+\w+\s*\{[^}]*?)(})/;
  const match = content.match(interfaceRegex);
  if (!match) return content;

  const tsTypeMap: Record<string, string> = {
    string: 'string',
    number: 'number',
    boolean: 'boolean',
    date: 'Date',
  };

  const fieldLines = fields
    .map((f) => `  ${f.name}: ${tsTypeMap[f.type.toLowerCase()] ?? 'string'};`)
    .join('\n');

  return content.replace(interfaceRegex, `$1${fieldLines}\n}`);
}
