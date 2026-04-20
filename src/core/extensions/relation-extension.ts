import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourceFilePath } from '../../utils/resolve-resource-path.js';
import { assertSafeResourceName } from '../../utils/sanitize.js';
import { toPascalCase, pluralizeResource } from '../../utils/naming.js';
import { addFieldsToInterface, addMethodToClass, ensureNamedImport } from '../ast/index.js';

export type RelationType = 'one-to-one' | 'one-to-many' | 'many-to-many';

interface RelationDefinition {
  sourceResource: string;
  targetResource: string;
  type: RelationType;
}

interface RelationResult {
  operations: FileOperation[];
  modifiedFiles: string[];
}

/**
 * Add a relation between two resources via AST transforms.
 *
 * Touches three things:
 *   - source `types`/`model`: adds the forward relation field + type import
 *   - target `types`/`model`: adds the inverse relation field + type import
 *   - source `repository`: adds a stub finder method + target model import
 *
 * Every edit is idempotent (re-running the command is safe) and is
 * recorded as a `FileOperation` so `pillar undo` can reverse it.
 */
export async function addRelationToResource(
  projectRoot: string,
  config: PillarConfig,
  relation: RelationDefinition,
): Promise<RelationResult> {
  assertSafeResourceName(relation.sourceResource);
  assertSafeResourceName(relation.targetResource);

  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const arch = config.project.architecture;
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  // Interfaces only exist in TS — relations on JS projects are a no-op by
  // design (the repository method stub is also skipped since there's no
  // compile-time type to import).
  if (!isTS) return { operations, modifiedFiles };

  const { sourceField, sourceType, inverseField, inverseType } = deriveFieldNames(relation);
  const sourcePascal = toPascalCase(relation.sourceResource);
  const targetPascal = toPascalCase(relation.targetResource);

  // Forward side: source interface gains `targetField: TargetType`.
  for (const suffix of ['types', 'model'] as const) {
    const ownerFile = path.join(projectRoot, resolveResourceFilePath(arch, relation.sourceResource, suffix, ext));
    const peerFile = path.join(projectRoot, resolveResourceFilePath(arch, relation.targetResource, suffix, ext));
    if (!(await fs.pathExists(ownerFile)) || !(await fs.pathExists(peerFile))) continue;

    const op = await injectRelationIntoInterface(
      ownerFile, peerFile, sourcePascal, targetPascal, sourceField, sourceType,
    );
    if (op) { operations.push(op); modifiedFiles.push(path.relative(projectRoot, ownerFile)); }
  }

  // Inverse side: target interface gains `sourceField: SourceType`.
  for (const suffix of ['types', 'model'] as const) {
    const ownerFile = path.join(projectRoot, resolveResourceFilePath(arch, relation.targetResource, suffix, ext));
    const peerFile = path.join(projectRoot, resolveResourceFilePath(arch, relation.sourceResource, suffix, ext));
    if (!(await fs.pathExists(ownerFile)) || !(await fs.pathExists(peerFile))) continue;

    const op = await injectRelationIntoInterface(
      ownerFile, peerFile, targetPascal, sourcePascal, inverseField, inverseType,
    );
    if (op) { operations.push(op); modifiedFiles.push(path.relative(projectRoot, ownerFile)); }
  }

  // Source repository gets a stub finder (e.g., `findPosts(userId)`).
  const repoPath = path.join(projectRoot, resolveResourceFilePath(arch, relation.sourceResource, 'repository', ext));
  if (await fs.pathExists(repoPath)) {
    const targetModelPath = path.join(projectRoot, resolveResourceFilePath(arch, relation.targetResource, 'model', ext));
    const op = await injectRelationMethod(repoPath, targetModelPath, relation, sourcePascal, targetPascal);
    if (op) { operations.push(op); modifiedFiles.push(path.relative(projectRoot, repoPath)); }
  }

  return { operations, modifiedFiles };
}

/**
 * Add a typed field to an interface (and its type import) via ts-morph.
 *
 * Returns null when the interface is not found in the source — the caller
 * skips the file rather than writing a half-applied edit.
 */
async function injectRelationIntoInterface(
  ownerFile: string,
  peerFile: string,
  ownerInterfaceName: string,
  peerTypeName: string,
  fieldName: string,
  fieldType: string,
): Promise<FileOperation | null> {
  const previousContent = await fs.readFile(ownerFile, 'utf-8');
  const importSpec = buildRelativeImportPath(ownerFile, peerFile);

  const afterImport = ensureNamedImport(previousContent, importSpec, peerTypeName, 'type');
  const afterField = addFieldsToInterface(afterImport, ownerInterfaceName, [
    { name: fieldName, type: fieldType, optional: true },
  ]);
  if (afterField === null || afterField === previousContent) return null;

  await fs.writeFile(ownerFile, afterField, 'utf-8');
  return { type: 'modify', path: ownerFile, previousContent };
}

/**
 * Append a finder method to the source repository class, plus the target
 * model type import. Idempotent on method name.
 */
async function injectRelationMethod(
  repoPath: string,
  targetModelPath: string,
  relation: RelationDefinition,
  sourcePascal: string,
  targetPascal: string,
): Promise<FileOperation | null> {
  const previousContent = await fs.readFile(repoPath, 'utf-8');

  const methodName = relation.type === 'one-to-one'
    ? `find${targetPascal}`
    : `find${toPascalCase(pluralizeResource(relation.targetResource))}`;

  const returnType = relation.type === 'one-to-one'
    ? `Promise<${targetPascal} | null>`
    : `Promise<${targetPascal}[]>`;

  const method = [
    `// Fetch related ${relation.targetResource}(s) for this ${relation.sourceResource}.`,
    `async ${methodName}(id: string): ${returnType} {`,
    `  // TODO: implement — query ${relation.targetResource}(s) by ${relation.sourceResource} id`,
    `  throw new Error('Not implemented');`,
    `}`,
  ].join('\n');

  let updated = previousContent;

  // Import the target model type if we have a file to import it from.
  // Skipping the import is tolerable (downstream tsc will flag it) rather
  // than aborting the whole method injection.
  if (await fs.pathExists(targetModelPath)) {
    const importSpec = buildRelativeImportPath(repoPath, targetModelPath);
    updated = ensureNamedImport(updated, importSpec, targetPascal, 'type');
  }

  const className = `${sourcePascal}Repository`;
  const afterMethod = addMethodToClass(updated, className, method);
  if (afterMethod === null || afterMethod === previousContent) return null;

  await fs.writeFile(repoPath, afterMethod, 'utf-8');
  return { type: 'modify', path: repoPath, previousContent };
}

function deriveFieldNames(relation: RelationDefinition): {
  sourceField: string;
  sourceType: string;
  inverseField: string;
  inverseType: string;
} {
  const { sourceResource: source, targetResource: target } = relation;
  const targetPascal = toPascalCase(target);
  const sourcePascal = toPascalCase(source);
  const targetPlural = pluralizeResource(target);
  const sourcePlural = pluralizeResource(source);

  switch (relation.type) {
    case 'one-to-one':
      return { sourceField: target, sourceType: targetPascal, inverseField: source, inverseType: sourcePascal };
    case 'one-to-many':
      return { sourceField: targetPlural, sourceType: `${targetPascal}[]`, inverseField: source, inverseType: sourcePascal };
    case 'many-to-many':
      return { sourceField: targetPlural, sourceType: `${targetPascal}[]`, inverseField: sourcePlural, inverseType: `${sourcePascal}[]` };
  }
}

/**
 * Build an ESM-compatible relative import specifier from `fromFile` to
 * `toFile`. Maps `.ts`/`.tsx` to `.js` (Node16 module resolution) and
 * ensures the path is explicitly relative.
 */
function buildRelativeImportPath(fromFile: string, toFile: string): string {
  let rel = path.relative(path.dirname(fromFile), toFile).replace(/\\/g, '/');
  rel = rel.replace(/\.tsx?$/, '.js');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}
