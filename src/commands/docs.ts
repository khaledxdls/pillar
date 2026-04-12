import path from 'node:path';
import http from 'node:http';
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

  const spec = await withSpinner('Scanning routes and models', async () => {
    return generateOpenAPISpec(projectRoot, config);
  });

  const outputPath = path.join(projectRoot, outputFile);

  await withSpinner(`Writing ${outputFile}`, async () => {
    await fs.ensureDir(path.dirname(outputPath));
    await fs.writeJson(outputPath, spec, { spaces: 2 });
  });

  const pathCount = Object.keys(spec.paths).length;
  const schemaCount = Object.keys(spec.components.schemas).length;

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

interface DocsServeOptions {
  port?: string;
  output?: string;
}

export async function docsServeCommand(options: DocsServeOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const specFile = options.output ?? 'docs/openapi.json';
  const specPath = path.join(projectRoot, specFile);
  const port = parseInt(options.port ?? '4000', 10);

  // Generate or read spec
  let spec: Record<string, unknown>;
  if (await fs.pathExists(specPath)) {
    spec = await fs.readJson(specPath) as Record<string, unknown>;
    logger.info(`Using existing spec: ${specFile}`);
  } else {
    spec = await withSpinner('Generating OpenAPI spec', async () => {
      return generateOpenAPISpec(projectRoot, config) as unknown as Record<string, unknown>;
    });
  }

  const specJson = JSON.stringify(spec);

  const html = buildSwaggerHtml(specJson);

  const server = http.createServer((req, res) => {
    if (req.url === '/openapi.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(specJson);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });

  server.listen(port, () => {
    logger.blank();
    logger.success('Swagger UI is running');
    logger.info(`  ${chalk.cyan(`http://localhost:${port}`)}`);
    logger.info(`  ${chalk.dim('Press Ctrl+C to stop')}`);
    logger.blank();
  });

  // Keep process alive, clean shutdown on SIGINT
  const shutdown = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Build a self-contained Swagger UI HTML page.
 * Uses the official Swagger UI CDN — no local dependencies needed.
 */
function buildSwaggerHtml(specJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pillar API Documentation</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      spec: ${specJson},
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIBundle.SwaggerUIStandalonePreset],
      layout: "BaseLayout"
    });
  </script>
</body>
</html>`;
}
