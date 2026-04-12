import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourcePath } from '../../utils/resolve-resource-path.js';

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
 * Add a relation between two resources.
 *
 * Updates:
 *   - Source model/types: adds the relation field
 *   - Target model/types: adds the inverse relation field
 *   - Source repository: adds a method to fetch related records
 */
export async function addRelationToResource(
  projectRoot: string,
  config: PillarConfig,
  relation: RelationDefinition,
): Promise<RelationResult> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  const sourceBase = resolveResourcePath(config.project.architecture, relation.sourceResource);
  const targetBase = resolveResourcePath(config.project.architecture, relation.targetResource);

  const { sourceField, sourceType, inverseField, inverseType } = deriveFieldNames(relation);

  const targetPascal = relation.targetResource.charAt(0).toUpperCase() + relation.targetResource.slice(1);
  const sourcePascal = relation.sourceResource.charAt(0).toUpperCase() + relation.sourceResource.slice(1);

  // 1. Update source types/model
  for (const suffix of ['types', 'model']) {
    const filePath = path.join(projectRoot, sourceBase, `${relation.sourceResource}.${suffix}.${ext}`);
    if (!await fs.pathExists(filePath)) continue;

    // Add import for the target type
    const importPath = path.relative(
      path.dirname(filePath),
      path.join(projectRoot, targetBase, `${relation.targetResource}.${suffix}.${ext}`),
    ).replace(/\\/g, '/').replace(/\.ts$/, '.js');
    const importLine = `import type { ${targetPascal} } from './${importPath}';`;
    await injectImportIfMissing(filePath, importLine, targetPascal);

    const result = await injectRelationField(filePath, relation.sourceResource, sourceField, sourceType, isTS);
    if (result) {
      operations.push(result.operation);
      modifiedFiles.push(path.relative(projectRoot, filePath));
    }
  }

  // 2. Update target types/model (inverse side)
  for (const suffix of ['types', 'model']) {
    const filePath = path.join(projectRoot, targetBase, `${relation.targetResource}.${suffix}.${ext}`);
    if (!await fs.pathExists(filePath)) continue;

    // Add import for the source type
    const importPath = path.relative(
      path.dirname(filePath),
      path.join(projectRoot, sourceBase, `${relation.sourceResource}.${suffix}.${ext}`),
    ).replace(/\\/g, '/').replace(/\.ts$/, '.js');
    const importLine = `import type { ${sourcePascal} } from './${importPath}';`;
    await injectImportIfMissing(filePath, importLine, sourcePascal);

    const result = await injectRelationField(filePath, relation.targetResource, inverseField, inverseType, isTS);
    if (result) {
      operations.push(result.operation);
      modifiedFiles.push(path.relative(projectRoot, filePath));
    }
  }

  // 3. Add finder method to source repository
  const repoPath = path.join(projectRoot, sourceBase, `${relation.sourceResource}.repository.${ext}`);
  if (await fs.pathExists(repoPath)) {
    const result = await injectRelationMethod(repoPath, relation, isTS);
    if (result) {
      operations.push(result.operation);
      modifiedFiles.push(path.relative(projectRoot, repoPath));
    }
  }

  return { operations, modifiedFiles };
}

function deriveFieldNames(relation: RelationDefinition): {
  sourceField: string;
  sourceType: string;
  inverseField: string;
  inverseType: string;
} {
  const target = relation.targetResource;
  const source = relation.sourceResource;
  const targetPascal = target.charAt(0).toUpperCase() + target.slice(1);
  const sourcePascal = source.charAt(0).toUpperCase() + source.slice(1);

  switch (relation.type) {
    case 'one-to-one':
      return {
        sourceField: target,
        sourceType: `${targetPascal}`,
        inverseField: source,
        inverseType: `${sourcePascal}`,
      };
    case 'one-to-many':
      return {
        sourceField: `${target}s`,
        sourceType: `${targetPascal}[]`,
        inverseField: source,
        inverseType: `${sourcePascal}`,
      };
    case 'many-to-many':
      return {
        sourceField: `${target}s`,
        sourceType: `${targetPascal}[]`,
        inverseField: `${source}s`,
        inverseType: `${sourcePascal}[]`,
      };
  }
}

async function injectRelationField(
  filePath: string,
  resourceName: string,
  fieldName: string,
  fieldType: string,
  isTS: boolean,
): Promise<{ operation: FileOperation } | null> {
  const content = await fs.readFile(filePath, 'utf-8');

  // Skip if field already exists
  if (content.includes(`${fieldName}:`) || content.includes(`${fieldName}?:`)) return null;

  const pascalName = resourceName.charAt(0).toUpperCase() + resourceName.slice(1);
  const interfacePattern = new RegExp(
    `(export\\s+interface\\s+${pascalName}\\s*\\{[^}]*?)(\\n})`,
  );
  const match = content.match(interfacePattern);
  if (!match) return null;

  const line = isTS
    ? `  ${fieldName}?: ${fieldType};`
    : `  ${fieldName}: null,`;

  const updated = content.replace(interfacePattern, `$1\n${line}\n}`);
  if (updated === content) return null;

  const previousContent = content;
  await fs.writeFile(filePath, updated, 'utf-8');
  return { operation: { type: 'modify', path: filePath, previousContent } };
}

async function injectRelationMethod(
  repoPath: string,
  relation: RelationDefinition,
  isTS: boolean,
): Promise<{ operation: FileOperation } | null> {
  const content = await fs.readFile(repoPath, 'utf-8');
  const previousContent = content;

  const target = relation.targetResource;
  const targetPascal = target.charAt(0).toUpperCase() + target.slice(1);
  const methodName = relation.type === 'one-to-one'
    ? `find${targetPascal}`
    : `find${targetPascal}s`;

  // Skip if method already exists
  if (content.includes(`${methodName}(`)) return null;

  const idParam = isTS ? 'id: string' : 'id';
  const returnType = isTS
    ? (relation.type === 'one-to-one' ? `: Promise<${targetPascal} | null>` : `: Promise<${targetPascal}[]>`)
    : '';

  const method = [
    '',
    `  // Fetch related ${target}(s) for this ${relation.sourceResource}`,
    `  async ${methodName}(${idParam})${returnType} {`,
    `    // TODO: implement — query ${target}(s) by ${relation.sourceResource} id`,
    `    throw new Error('Not implemented');`,
    `  }`,
  ].join('\n');

  // Insert before the last closing brace of the class
  const lastBrace = content.lastIndexOf('}');
  if (lastBrace === -1) return null;

  const updated = content.slice(0, lastBrace) + method + '\n' + content.slice(lastBrace);
  await fs.writeFile(repoPath, updated, 'utf-8');
  return { operation: { type: 'modify', path: repoPath, previousContent } };
}

/**
 * Add an import statement to a file if the type name is not already imported.
 */
async function injectImportIfMissing(filePath: string, importLine: string, typeName: string): Promise<void> {
  const content = await fs.readFile(filePath, 'utf-8');

  // Skip if the type is already imported
  if (content.includes(`import`) && content.includes(typeName) && content.match(new RegExp(`import.*\\b${typeName}\\b.*from`))) {
    return;
  }

  // Add import after the last existing import or at the top
  const lines = content.split('\n');
  let lastImportIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().startsWith('import ')) {
      lastImportIndex = i;
    }
  }

  if (lastImportIndex >= 0) {
    lines.splice(lastImportIndex + 1, 0, importLine);
  } else {
    // Insert after the purpose comment
    const purposeIndex = lines.findIndex((l) => l.startsWith('// Purpose:'));
    lines.splice(purposeIndex >= 0 ? purposeIndex + 1 : 0, 0, '', importLine);
  }

  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
}
