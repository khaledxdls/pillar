import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { AIGenerationPlan, AIFileAction } from './types.js';
import type { FileOperation } from '../history/types.js';
import { generateSkeleton } from '../generator/skeleton.js';
import { generateDiff, generateCreatePreview } from '../../utils/diff.js';

export interface ExecutionWarning {
  /** `skip-existing` — create target already on disk; `skip-missing` —
   *  modify target not on disk; `outside-root` — path resolved outside the
   *  project (defensive — schema should already reject these);
   *  `noop-modify` — model emitted a modify action with no imports,
   *  registrations, or methods to inject, so nothing could be applied. */
  reason: 'skip-existing' | 'skip-missing' | 'outside-root' | 'noop-modify';
  path: string;
}

interface ExecutionResult {
  operations: FileOperation[];
  createdFiles: string[];
  modifiedFiles: string[];
  warnings: ExecutionWarning[];
}

export interface PlanDiffPreview {
  diffs: Array<{ path: string; diff: string }>;
  warnings: ExecutionWarning[];
}

/**
 * Resolve a plan-relative path against the project root and verify it stays
 * inside. Returns `null` on escape — caller surfaces as `outside-root`.
 *
 * The schema already rejects `..` and absolute paths, but `path.resolve`
 * normalization can still surface symlink-style edge cases on some hosts.
 * This is the last line of defense before any filesystem write.
 */
function resolveSafe(projectRoot: string, relPath: string): string | null {
  const resolved = path.resolve(projectRoot, relPath);
  const rootWithSep = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  if (resolved !== projectRoot && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

/**
 * Execute an AI generation plan by creating/modifying files.
 *
 * Behavior:
 *   - `create` actions: skip if target exists (warn), reject if outside root.
 *   - `modify` actions: skip if target missing (warn), reject if outside root.
 *   - All operations recorded for single-step undo.
 *
 * The executor is a pure function over (filesystem, config, plan) — it
 * never calls out to providers or prompts the user. The command layer owns
 * confirmation and history bookkeeping.
 */
export async function executePlan(
  projectRoot: string,
  config: PillarConfig,
  plan: AIGenerationPlan,
): Promise<ExecutionResult> {
  const operations: FileOperation[] = [];
  const createdFiles: string[] = [];
  const modifiedFiles: string[] = [];
  const warnings: ExecutionWarning[] = [];

  for (const action of plan.create) {
    const fullPath = resolveSafe(projectRoot, action.path);
    if (!fullPath) {
      warnings.push({ reason: 'outside-root', path: action.path });
      continue;
    }
    if (await fs.pathExists(fullPath)) {
      warnings.push({ reason: 'skip-existing', path: action.path });
      continue;
    }

    const content = generateFileFromAction(action, config);
    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    operations.push({ type: 'create', path: action.path });
    createdFiles.push(action.path);
  }

  for (const action of plan.modify) {
    const fullPath = resolveSafe(projectRoot, action.path);
    if (!fullPath) {
      warnings.push({ reason: 'outside-root', path: action.path });
      continue;
    }
    if (!(await fs.pathExists(fullPath))) {
      warnings.push({ reason: 'skip-missing', path: action.path });
      continue;
    }
    if (!hasInjectionPayload(action)) {
      // Modify action with only a `purpose` — the model described the
      // change in prose but didn't emit structural fields. Surface this
      // loudly so the operator knows the plan was incomplete and can
      // re-prompt rather than silently succeeding with no changes.
      warnings.push({ reason: 'noop-modify', path: action.path });
      continue;
    }

    const previousContent = await fs.readFile(fullPath, 'utf-8');
    const updated = applyModification(previousContent, action, config);

    if (updated !== previousContent) {
      await fs.writeFile(fullPath, updated, 'utf-8');
      operations.push({ type: 'modify', path: action.path, previousContent });
      modifiedFiles.push(action.path);
    } else {
      // Payload was structurally non-empty but every entry was a duplicate —
      // method/import/registration that already exists. Surface this so the
      // operator doesn't see "AI generation complete" with zero diff.
      warnings.push({ reason: 'noop-modify', path: action.path });
    }
  }

  return { operations, createdFiles, modifiedFiles, warnings };
}

/**
 * True iff a modify action carries at least one structural injection the
 * executor knows how to apply. Returning false means the action is a
 * description without an operation — the command layer should surface it.
 */
function hasInjectionPayload(action: AIFileAction): boolean {
  return (
    (action.imports !== undefined && action.imports.length > 0)
    || (action.registrations !== undefined && action.registrations.length > 0)
    || (action.methods !== undefined && action.methods.length > 0)
  );
}

/**
 * Generate a diff preview of what the plan would do, without writing any files.
 * Returns the same warning shape as `executePlan` so the command layer can
 * surface them before asking the user to confirm.
 */
export async function previewPlan(
  projectRoot: string,
  config: PillarConfig,
  plan: AIGenerationPlan,
): Promise<PlanDiffPreview> {
  const diffs: Array<{ path: string; diff: string }> = [];
  const warnings: ExecutionWarning[] = [];

  for (const action of plan.create) {
    const fullPath = resolveSafe(projectRoot, action.path);
    if (!fullPath) {
      warnings.push({ reason: 'outside-root', path: action.path });
      continue;
    }
    if (await fs.pathExists(fullPath)) {
      warnings.push({ reason: 'skip-existing', path: action.path });
      continue;
    }

    const content = generateFileFromAction(action, config);
    diffs.push({ path: action.path, diff: generateCreatePreview(content, action.path) });
  }

  for (const action of plan.modify) {
    const fullPath = resolveSafe(projectRoot, action.path);
    if (!fullPath) {
      warnings.push({ reason: 'outside-root', path: action.path });
      continue;
    }
    if (!(await fs.pathExists(fullPath))) {
      warnings.push({ reason: 'skip-missing', path: action.path });
      continue;
    }
    if (!hasInjectionPayload(action)) {
      warnings.push({ reason: 'noop-modify', path: action.path });
      continue;
    }

    const oldContent = await fs.readFile(fullPath, 'utf-8');
    const newContent = applyModification(oldContent, action, config);

    if (newContent !== oldContent) {
      diffs.push({ path: action.path, diff: generateDiff(oldContent, newContent, action.path) });
    }
  }

  return { diffs, warnings };
}

/**
 * Generate file content from an AI action.
 * Uses AI-provided content for custom files, skeleton engine for standard CRUD.
 */
function generateFileFromAction(action: AIFileAction, config: PillarConfig): string {
  if (action.content) {
    const header = `// Purpose: ${action.purpose}\n\n`;
    return header + action.content;
  }

  const fileName = path.basename(action.path);

  let content = generateSkeleton(fileName, action.purpose, {
    stack: config.project.stack,
    language: config.project.language,
    architecture: config.project.architecture,
    testFramework: config.generation.testFramework,
  });

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

  if (action.imports && action.imports.length > 0) {
    updated = injectImports(updated, action.imports);
  }

  if (action.registrations && action.registrations.length > 0) {
    updated = injectRegistrations(updated, action.registrations);
  }

  if (action.methods && action.methods.length > 0) {
    updated = injectMethods(updated, action.methods, action.kind, config);
  }

  return updated;
}

/**
 * Insert import statements after the last existing import. The previous
 * implementation only recognized single-line `import X from 'y';` lines —
 * multi-line imports (`import {\n  a,\n  b\n} from 'x';`) were treated as
 * non-import code and broke the cursor early.
 *
 * Strategy: walk lines tracking `inMultilineImport`. A line that starts an
 * `import {` without a matching `}` opens the block; any subsequent line
 * containing `}` closes it. The last line *closing* an import (single or
 * multi) becomes the insertion point.
 */
function injectImports(content: string, imports: string[]): string {
  const newImports = imports.filter((imp) => !content.includes(imp));
  if (newImports.length === 0) return content;

  const lines = content.split('\n');
  let lastImportEnd = -1;
  let inMultilineImport = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();

    if (inMultilineImport) {
      if (trimmed.includes('}')) {
        lastImportEnd = i;
        inMultilineImport = false;
      }
      continue;
    }

    if (trimmed.startsWith('import ') || trimmed.startsWith('import{')) {
      // Single-line import has its own `;` terminator on the same line.
      // Multi-line is detected by an opening `{` without a closing `}`.
      const opens = (trimmed.match(/\{/g) ?? []).length;
      const closes = (trimmed.match(/\}/g) ?? []).length;
      if (opens > closes) {
        inMultilineImport = true;
      } else {
        lastImportEnd = i;
      }
      continue;
    }

    // Skip blank lines and standalone comments — they don't end the import block.
    if (trimmed === '' || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      continue;
    }

    // First real code line: stop scanning.
    if (lastImportEnd >= 0) break;
  }

  const insertAt = lastImportEnd >= 0 ? lastImportEnd + 1 : 0;
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

  const todoMatch = content.match(/^[ \t]*\/\/\s*TODO:?\s*register.*$/m);
  if (todoMatch && todoMatch.index !== undefined) {
    return content.slice(0, todoMatch.index) + regBlock + '\n' + content.slice(todoMatch.index);
  }

  const exportMatch = content.match(/^(export\s+\{[^}]*(app|router)|export\s+default\s+(app|router))/m);
  if (exportMatch && exportMatch.index !== undefined) {
    return content.slice(0, exportMatch.index) + regBlock + '\n' + content.slice(exportMatch.index);
  }

  const lastExportIndex = content.lastIndexOf('\nexport');
  if (lastExportIndex !== -1) {
    return content.slice(0, lastExportIndex) + regBlock + content.slice(lastExportIndex);
  }

  return content + regBlock;
}

/**
 * Inject methods into the last class body.
 * Only targets actual class declarations, not export blocks.
 */
function injectMethods(
  content: string,
  methods: Array<{ name: string; description: string; signature?: string }>,
  kind: string | undefined,
  config: PillarConfig,
): string {
  let updated = content;
  const isTS = config.project.language === 'typescript';

  if (findLastClassClosingBrace(updated) === -1) return updated;

  for (const method of methods) {
    if (updated.includes(`${method.name}(`)) continue;

    let newMethod: string;
    // Explicit signature wins — lets the model wire a controller call like
    // `this.svc.search(q)` with a matching `search(q: string)` on the
    // service side. Default body throws — the AI is responsible for TODO
    // implementation, we only guarantee the signature type-checks.
    if (method.signature) {
      newMethod = [
        '',
        `  // ${method.description}`,
        `  async ${method.name}${method.signature} {`,
        `    // TODO: implement`,
        `    throw new Error("Not implemented");`,
        `  }`,
      ].join('\n');
    } else if (kind === 'controller') {
      let params: string;
      let body: string;
      switch (config.project.stack) {
        case 'fastify':
          params = isTS ? 'req: FastifyRequest, res: FastifyReply' : 'req, res';
          body = 'return res.send({ message: "not implemented" });';
          break;
        case 'hono':
          params = isTS ? 'c: Context' : 'c';
          body = 'return c.json({ message: "not implemented" });';
          break;
        case 'nestjs':
          // Nest controllers are decorator-driven; framework calls handlers
          // with whatever decorator-bound args the AI declares. Without a
          // `signature` from the AI we can't know the param shape, so we
          // emit a parameterless stub — safer than hallucinating req/res
          // (Nest doesn't use them) which collapses to `globalThis.Response`
          // and fails type-check.
          params = '';
          body = 'return { message: "not implemented" };';
          break;
        default:
          params = isTS ? 'req: Request, res: Response' : 'req, res';
          body = 'res.json({ message: "not implemented" });';
          break;
      }
      newMethod = [
        '',
        `  // ${method.description}`,
        `  async ${method.name}(${params}) {`,
        `    // TODO: implement`,
        `    ${body}`,
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
 * Avoids injecting into export blocks, object literals, or functions.
 */
function findLastClassClosingBrace(content: string): number {
  const classRegex = /\bclass\s+\w+/g;
  let lastClassStart = -1;
  let match: RegExpExecArray | null;

  while ((match = classRegex.exec(content)) !== null) {
    lastClassStart = match.index;
  }

  if (lastClassStart === -1) return -1;

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
