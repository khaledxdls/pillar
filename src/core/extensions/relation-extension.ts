import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { PlanBuilder, PlanExecutor } from '../plan/index.js';
import type { Plan } from '../plan/index.js';
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
 * Compute the Plan for a resource relation. No I/O writes.
 *
 * Touches:
 *   - source `types`/`model`: forward relation field + type import
 *   - target `types`/`model`: inverse relation field + type import
 *   - source `repository`: stub finder method + target model type import
 *
 * TypeScript only — on JS projects there's no compile-time type to
 * import, so the plan is empty by design.
 */
export async function planRelationExtension(
  projectRoot: string,
  config: PillarConfig,
  relation: RelationDefinition,
  command: string,
): Promise<Plan> {
  assertSafeResourceName(relation.sourceResource);
  assertSafeResourceName(relation.targetResource);

  const builder = new PlanBuilder(projectRoot, command);

  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const arch = config.project.architecture;
  if (!isTS) return builder.build();

  const { sourceField, sourceType, inverseField, inverseType } = deriveFieldNames(relation);
  const sourcePascal = toPascalCase(relation.sourceResource);
  const targetPascal = toPascalCase(relation.targetResource);

  // Forward side: source interface gains `targetField: TargetType`.
  for (const suffix of ['types', 'model'] as const) {
    await planInterfaceRelationEdit(builder, projectRoot, {
      ownerFile: resolveResourceFilePath(arch, relation.sourceResource, suffix, ext),
      peerFile: resolveResourceFilePath(arch, relation.targetResource, suffix, ext),
      ownerInterface: sourcePascal,
      peerType: targetPascal,
      fieldName: sourceField,
      fieldType: sourceType,
    });
  }

  // Inverse side: target interface gains `sourceField: SourceType`.
  for (const suffix of ['types', 'model'] as const) {
    await planInterfaceRelationEdit(builder, projectRoot, {
      ownerFile: resolveResourceFilePath(arch, relation.targetResource, suffix, ext),
      peerFile: resolveResourceFilePath(arch, relation.sourceResource, suffix, ext),
      ownerInterface: targetPascal,
      peerType: sourcePascal,
      fieldName: inverseField,
      fieldType: inverseType,
    });
  }

  // Source repository gets a stub finder (e.g., `findPosts(userId)`).
  await planRepositoryRelationEdit(builder, projectRoot, {
    repoFile: resolveResourceFilePath(arch, relation.sourceResource, 'repository', ext),
    targetModelFile: resolveResourceFilePath(arch, relation.targetResource, 'model', ext),
    sourcePascal,
    targetPascal,
    relation,
  });

  return builder.build();
}

export async function addRelationToResource(
  projectRoot: string,
  config: PillarConfig,
  relation: RelationDefinition,
): Promise<RelationResult> {
  const plan = await planRelationExtension(
    projectRoot,
    config,
    relation,
    `add relation ${relation.sourceResource}→${relation.targetResource} (${relation.type})`,
  );
  const { operations, touched } = await new PlanExecutor(projectRoot).execute(plan);
  return { operations, modifiedFiles: touched };
}

interface InterfaceRelationEdit {
  ownerFile: string;
  peerFile: string;
  ownerInterface: string;
  peerType: string;
  fieldName: string;
  fieldType: string;
}

async function planInterfaceRelationEdit(
  builder: PlanBuilder,
  projectRoot: string,
  edit: InterfaceRelationEdit,
): Promise<void> {
  const ownerFull = path.join(projectRoot, edit.ownerFile);
  const peerFull = path.join(projectRoot, edit.peerFile);
  if (!(await fs.pathExists(ownerFull)) || !(await fs.pathExists(peerFull))) return;

  const previous = await fs.readFile(ownerFull, 'utf-8');
  const importSpec = buildRelativeImportPath(ownerFull, peerFull);

  const afterImport = ensureNamedImport(previous, importSpec, edit.peerType, 'type');
  const afterField = addFieldsToInterface(afterImport, edit.ownerInterface, [
    { name: edit.fieldName, type: edit.fieldType, optional: true },
  ]);
  if (afterField === null || afterField === previous) return;

  await builder.modify(edit.ownerFile, afterField, `add relation field ${edit.fieldName} on ${edit.ownerInterface}`);
}

interface RepositoryRelationEdit {
  repoFile: string;
  targetModelFile: string;
  sourcePascal: string;
  targetPascal: string;
  relation: RelationDefinition;
}

async function planRepositoryRelationEdit(
  builder: PlanBuilder,
  projectRoot: string,
  edit: RepositoryRelationEdit,
): Promise<void> {
  const repoFull = path.join(projectRoot, edit.repoFile);
  if (!(await fs.pathExists(repoFull))) return;

  const previous = await fs.readFile(repoFull, 'utf-8');

  const methodName = edit.relation.type === 'one-to-one'
    ? `find${edit.targetPascal}`
    : `find${toPascalCase(pluralizeResource(edit.relation.targetResource))}`;

  const returnType = edit.relation.type === 'one-to-one'
    ? `Promise<${edit.targetPascal} | null>`
    : `Promise<${edit.targetPascal}[]>`;

  const method = [
    `// Fetch related ${edit.relation.targetResource}(s) for this ${edit.relation.sourceResource}.`,
    `async ${methodName}(id: string): ${returnType} {`,
    `  // TODO: implement — query ${edit.relation.targetResource}(s) by ${edit.relation.sourceResource} id`,
    `  throw new Error('Not implemented');`,
    `}`,
  ].join('\n');

  let updated = previous;

  // Import the target model type if a file exists to import it from.
  // A missing target model is tolerable (tsc will flag it) rather than
  // aborting the whole method injection.
  const targetModelFull = path.join(projectRoot, edit.targetModelFile);
  if (await fs.pathExists(targetModelFull)) {
    const importSpec = buildRelativeImportPath(repoFull, targetModelFull);
    updated = ensureNamedImport(updated, importSpec, edit.targetPascal, 'type');
  }

  const className = `${edit.sourcePascal}Repository`;
  const afterMethod = addMethodToClass(updated, className, method);
  if (afterMethod === null || afterMethod === previous) return;

  await builder.modify(edit.repoFile, afterMethod, `add ${methodName} to ${className}`);
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
