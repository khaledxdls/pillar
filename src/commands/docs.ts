import path from 'node:path';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { generateOpenAPISpec } from '../core/docs/index.js';
import { HistoryManager } from '../core/history/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface DocsOptions {
  output?: string;
}

export async function docsGenerateCommand(options: DocsOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const outputFile = options.output ?? 'docs/openapi.json';

  let spec: Awaited<ReturnType<typeof generateOpenAPISpec>>;

  await withSpinner('Scanning routes and models', async () => {
    spec = await generateOpenAPISpec(projectRoot, config);
  });

  const outputPath = path.join(projectRoot, outputFile);

  await withSpinner(`Writing ${outputFile}`, async () => {
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeJson(outputPath, spec!, { spaces: 2 });
  });

  const pathCount = Object.keys(spec!.paths).length;
  const schemaCount = Object.keys(spec!.components.schemas).length;

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record('docs generate', [{ type: 'create', path: outputFile }]);

  logger.blank();
  logger.success('API documentation generated');
  logger.table([
    ['Paths', String(pathCount)],
    ['Schemas', String(schemaCount)],
    ['Output', outputFile],
    ['Format', 'OpenAPI 3.0.3'],
  ]);
  logger.blank();
  logger.info('View the spec with any OpenAPI viewer (e.g., Swagger Editor).');
  logger.blank();
}
