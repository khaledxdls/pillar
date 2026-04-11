import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import { parseFieldDef, addFieldToResource } from '../core/extensions/field-extension.js';
import { parseEndpointDef, addEndpointToResource } from '../core/extensions/endpoint-extension.js';
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

  const fields = fieldStrings.map((f) => {
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
    logger.warn(`No files were modified. Check that resource "${resourceName}" exists.`);
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
  const endpoint = parseEndpointDef(endpointStr);
  const purpose = options.purpose ?? `${endpoint.method} ${endpoint.path}`;

  const result = await withSpinner(
    `Adding endpoint ${endpoint.method} ${endpoint.path} to ${resourceName}`,
    async () => addEndpointToResource(projectRoot, config, resourceName, endpoint, purpose),
  );

  if (result.modifiedFiles.length === 0) {
    logger.warn(`No files were modified. Check that resource "${resourceName}" exists.`);
    return;
  }

  // Update map with endpoint purpose
  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    for (const file of result.modifiedFiles) {
      const existing = await mapManager.load();
      if (existing) {
        // Keep existing purpose, just note the addition
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

async function requireProject(): Promise<string | null> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return null;
  }
  return projectRoot;
}
