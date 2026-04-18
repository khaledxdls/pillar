import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import { parseFieldDef, addFieldToResource } from '../core/extensions/field-extension.js';
import { parseEndpointDef, addEndpointToResource } from '../core/extensions/endpoint-extension.js';
import { addRelationToResource, type RelationType } from '../core/extensions/relation-extension.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface AddFieldOptions {
  unique?: boolean;
  optional?: boolean;
}

export async function addFieldCommand(
  resourceName: string,
  fieldStrings: string[],
  options: AddFieldOptions,
): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const config = await loadConfig(projectRoot);

  // Handle both quoted multi-field strings and separate arguments
  // e.g., "role:string isActive:boolean" or role:string isActive:boolean
  const fields = fieldStrings
    .flatMap((f) => f.trim().split(/\s+/))
    .filter((f) => f.includes(':'))
    .map((f) => {
      const def = parseFieldDef(f);
      if (options.unique) def.unique = true;
      if (options.optional) def.optional = true;
      return def;
    });

  const result = await withSpinner(
    `Adding ${fields.length} field(s) to ${resourceName}`,
    async () => addFieldToResource(projectRoot, config, resourceName, fields),
  );

  if (result.modifiedFiles.length === 0) {
    logger.error(`No files were modified. Check that resource "${resourceName}" exists.`);
    process.exitCode = 1;
    return;
  }

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record(`add field ${resourceName} ${fieldStrings.join(' ')}`, result.operations);

  logger.blank();
  logger.success(`Added fields to ${resourceName}`);
  logger.info('Modified files:');
  logger.list(result.modifiedFiles);
  logger.blank();
}

interface AddEndpointOptions {
  purpose?: string;
}

export async function addEndpointCommand(
  resourceName: string,
  endpointStr: string,
  options: AddEndpointOptions,
): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const config = await loadConfig(projectRoot);

  if (config.generation.purposeRequired && !options.purpose) {
    logger.error(
      'A --purpose is required by this project configuration.',
      'Re-run with -p "<why this endpoint exists>" or set generation.purposeRequired=false.',
    );
    process.exitCode = 1;
    return;
  }

  const endpoint = parseEndpointDef(endpointStr, resourceName);
  const purpose = options.purpose ?? `${endpoint.method} ${endpoint.path}`;

  const result = await withSpinner(
    `Adding endpoint ${endpoint.method} ${endpoint.path} to ${resourceName}`,
    async () => addEndpointToResource(projectRoot, config, resourceName, endpoint, purpose),
  );

  if (result.modifiedFiles.length === 0) {
    logger.error(`No files were modified. Check that resource "${resourceName}" exists.`);
    process.exitCode = 1;
    return;
  }

  // Update map with endpoint purpose
  if (config.map.autoUpdate && result.modifiedFiles.length > 0) {
    const mapManager = new MapManager(projectRoot);
    const map = await mapManager.load();
    if (map) {
      for (const file of result.modifiedFiles) {
        await mapManager.registerEntry(file, `(updated) added ${endpoint.method} ${endpoint.path}`);
      }
    }
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`add endpoint ${resourceName} "${endpointStr}"`, result.operations);

  logger.blank();
  logger.success(`Added ${endpoint.method} ${endpoint.path} to ${resourceName}`);
  logger.info('Modified files:');
  logger.list(result.modifiedFiles);
  logger.blank();
}

interface AddRelationOptions {
  type?: string;
}

const VALID_RELATION_TYPES = new Set(['one-to-one', 'one-to-many', 'many-to-many']);

export async function addRelationCommand(
  sourceResource: string,
  targetResource: string,
  options: AddRelationOptions,
): Promise<void> {
  const projectRoot = await requireProject();
  if (!projectRoot) return;

  const relationType = (options.type ?? 'one-to-many') as RelationType;
  if (!VALID_RELATION_TYPES.has(relationType)) {
    logger.error(
      `Invalid relation type: "${relationType}"`,
      'Use one of: one-to-one, one-to-many, many-to-many',
    );
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);

  const result = await withSpinner(
    `Adding ${relationType} relation: ${sourceResource} → ${targetResource}`,
    async () =>
      addRelationToResource(projectRoot, config, {
        sourceResource,
        targetResource,
        type: relationType,
      }),
  );

  if (result.modifiedFiles.length === 0) {
    logger.error(
      `No files were modified. Check that resources "${sourceResource}" and "${targetResource}" exist.`,
    );
    process.exitCode = 1;
    return;
  }

  // Update map
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    const map = await mapManager.load();
    if (map) {
      for (const file of result.modifiedFiles) {
        await mapManager.registerEntry(file, `(updated) added ${relationType} relation: ${sourceResource} ↔ ${targetResource}`);
      }
    }
  }

  const history = new HistoryManager(projectRoot);
  await history.record(`add relation ${sourceResource} ${targetResource} --type ${relationType}`, result.operations);

  logger.blank();
  logger.success(`Added ${relationType} relation: ${sourceResource} → ${targetResource}`);
  logger.info('Modified files:');
  logger.list(result.modifiedFiles);
  logger.blank();
}

async function requireProject(): Promise<string | null> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return null;
  }
  return projectRoot;
}
