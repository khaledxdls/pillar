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
 * Execute an AI generation plan by creating/modifying files
 * using Pillar's deterministic skeleton engine.
 *
 * The AI plan tells us WHAT to create; the skeleton engine decides HOW.
 * This ensures consistent, predictable code regardless of AI output variance.
 */
export async function executePlan(
  projectRoot: string,
  config: PillarConfig,
  plan: AIGenerationPlan,
): Promise<ExecutionResult> {
  const operations: FileOperation[] = [];
  const createdFiles: string[] = [];
  const modifiedFiles: string[] = [];

  // Process file creations
  for (const action of plan.create) {
    const fullPath = path.join(projectRoot, action.path);

    if (await fs.pathExists(fullPath)) {
      // File already exists — skip to avoid overwriting
      continue;
    }

    const content = generateFileFromAction(action, config);

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, content, 'utf-8');
    operations.push({ type: 'create', path: action.path });
    createdFiles.push(action.path);
  }

  // Process file modifications
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
 * Generate file content from an AI action using the skeleton engine.
 */
function generateFileFromAction(action: AIFileAction, config: PillarConfig): string {
  const fileName = path.basename(action.path);

  // Use the skeleton engine for the base structure
  let content = generateSkeleton(fileName, action.purpose, {
    stack: config.project.stack,
    language: config.project.language,
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
 * Adds new methods to classes.
 */
function applyModification(
  content: string,
  action: AIFileAction,
  config: PillarConfig,
): string {
  let updated = content;
  const isTS = config.project.language === 'typescript';

  if (action.methods) {
    for (const method of action.methods) {
      // Check if method already exists
      if (content.includes(`${method.name}(`)) continue;

      // Find the last closing brace of a class
      const lastBrace = updated.lastIndexOf('}');
      if (lastBrace === -1) continue;

      const reqType = isTS ? 'req: Request' : 'req';
      const resType = isTS ? 'res: Response' : 'res';

      let newMethod: string;
      if (action.kind === 'controller') {
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

      updated = updated.slice(0, lastBrace) + newMethod + '\n' + updated.slice(lastBrace);
    }
  }

  return updated;
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
