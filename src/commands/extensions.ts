import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import { PlanExecutor } from '../core/plan/index.js';
import {
  parseFieldDef,
  planFieldExtension,
  parseEndpointDef,
  planEndpointExtension,
  planRelationExtension,
  type RelationType,
} from '../core/extensions/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';
import { isPreview, printPlan, type PreviewFlags } from './_preview.js';
import { maybeAutoGenerateMigration } from './_post-schema-hook.js';

interface AddFieldOptions extends PreviewFlags {
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

  // Tolerate both quoted multi-field strings and separate arguments:
  //   "role:string isActive:boolean"  or  role:string isActive:boolean
  const fields = fieldStrings
    .flatMap((f) => f.trim().split(/\s+/))
    .filter((f) => f.includes(':'))
    .map((f) => {
      const def = parseFieldDef(f);
      if (options.unique) def.unique = true;
      if (options.optional) def.optional = true;
      return def;
    });

  const command = `add field ${resourceName} ${fieldStrings.join(' ')}`.trim();
  const plan = await planFieldExtension(projectRoot, config, resourceName, fields, command);

  if (isPreview(options)) {
    printPlan(plan);
    await maybeAutoGenerateMigration({
      projectRoot,
      config,
      reason: 'field',
      subject: resourceName,
      preview: true,
    });
    return;
  }

  if (plan.changes.length === 0) {
    logger.error(`No files were modified. Check that resource "${resourceName}" exists.`);
    process.exitCode = 1;
    return;
  }

  const { operations, touched } = await withSpinner(
    `Adding ${fields.length} field(s) to ${resourceName}`,
    async () => new PlanExecutor(projectRoot).execute(plan),
  );

  await new HistoryManager(projectRoot).record(command, operations);

  logger.blank();
  logger.success(`Added fields to ${resourceName}`);
  logger.info('Modified files:');
  logger.list(touched);
  logger.blank();

  await maybeAutoGenerateMigration({
    projectRoot,
    config,
    reason: 'field',
    subject: resourceName,
  });
}

interface AddEndpointOptions extends PreviewFlags {
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
  const command = `add endpoint ${resourceName} "${endpointStr}"`;

  const plan = await planEndpointExtension(projectRoot, config, resourceName, endpoint, purpose, command);

  if (isPreview(options)) {
    printPlan(plan);
    return;
  }

  if (plan.changes.length === 0) {
    logger.error(`No files were modified. Check that resource "${resourceName}" exists.`);
    process.exitCode = 1;
    return;
  }

  const { operations, touched } = await withSpinner(
    `Adding endpoint ${endpoint.method} ${endpoint.path} to ${resourceName}`,
    async () => new PlanExecutor(projectRoot).execute(plan),
  );

  // Map updates reflect the new endpoint purpose, not the file delta.
  if (config.map.autoUpdate && touched.length > 0) {
    const mapManager = new MapManager(projectRoot);
    const map = await mapManager.load();
    if (map) {
      for (const file of touched) {
        await mapManager.registerEntry(file, `(updated) added ${endpoint.method} ${endpoint.path}`);
      }
    }
  }

  await new HistoryManager(projectRoot).record(command, operations);

  logger.blank();
  logger.success(`Added ${endpoint.method} ${endpoint.path} to ${resourceName}`);
  logger.info('Modified files:');
  logger.list(touched);
  logger.blank();
}

interface AddRelationOptions extends PreviewFlags {
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
  const command = `add relation ${sourceResource} ${targetResource} --type ${relationType}`;

  const plan = await planRelationExtension(
    projectRoot,
    config,
    { sourceResource, targetResource, type: relationType },
    command,
  );

  if (isPreview(options)) {
    printPlan(plan);
    await maybeAutoGenerateMigration({
      projectRoot,
      config,
      reason: 'relation',
      subject: `${sourceResource}_${targetResource}_${relationType}`,
      preview: true,
    });
    return;
  }

  if (plan.changes.length === 0) {
    logger.error(
      `No files were modified. Check that resources "${sourceResource}" and "${targetResource}" exist.`,
    );
    process.exitCode = 1;
    return;
  }

  const { operations, touched } = await withSpinner(
    `Adding ${relationType} relation: ${sourceResource} → ${targetResource}`,
    async () => new PlanExecutor(projectRoot).execute(plan),
  );

  if (config.map.autoUpdate) {
    const mapManager = new MapManager(projectRoot);
    const map = await mapManager.load();
    if (map) {
      for (const file of touched) {
        await mapManager.registerEntry(
          file,
          `(updated) added ${relationType} relation: ${sourceResource} ↔ ${targetResource}`,
        );
      }
    }
  }

  await new HistoryManager(projectRoot).record(command, operations);

  logger.blank();
  logger.success(`Added ${relationType} relation: ${sourceResource} → ${targetResource}`);
  logger.info('Modified files:');
  logger.list(touched);
  logger.blank();

  await maybeAutoGenerateMigration({
    projectRoot,
    config,
    reason: 'relation',
    subject: `${sourceResource}_${targetResource}_${relationType}`,
  });
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
