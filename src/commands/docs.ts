import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
  const assetsDir = resolveSwaggerAssetsDir();
  const html = buildSwaggerHtml();

  const server = http.createServer((req, res) => {
    void handleDocsRequest(req, res, { specJson, html, assetsDir }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal error: ${(err as Error).message}`);
    });
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
 * Serve Swagger UI assets from the installed `swagger-ui-dist` package so
 * `pillar docs serve` works offline and in air-gapped environments. Routes:
 *   - `/`                 → HTML shell
 *   - `/openapi.json`     → the generated spec
 *   - `/assets/<file>`    → static assets from `swagger-ui-dist`
 *
 * The assets directory is resolved once per serve call and the file reads
 * are scoped to it, so arbitrary path traversal is not possible.
 */
interface DocsRouteContext {
  specJson: string;
  html: string;
  assetsDir: string;
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function handleDocsRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: DocsRouteContext,
): Promise<void> {
  const url = req.url ?? '/';

  if (url === '/openapi.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(ctx.specJson);
    return;
  }

  if (url.startsWith('/assets/')) {
    const assetName = path.posix.normalize(url.slice('/assets/'.length));
    // Reject any path that escapes the assets dir.
    if (assetName.startsWith('..') || assetName.includes('\0') || path.isAbsolute(assetName)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    const filePath = path.join(ctx.assetsDir, assetName);
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(ctx.assetsDir) + path.sep)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    if (!(await fs.pathExists(resolved))) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const contentType = ASSET_CONTENT_TYPES[path.extname(resolved).toLowerCase()]
      ?? 'application/octet-stream';
    const data = await fs.readFile(resolved);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(ctx.html);
}

/**
 * Resolve the on-disk path of `swagger-ui-dist` using Node's resolver. This
 * works whether Pillar is installed globally, locally, or via npx — the
 * resolver walks up from this file's location, not from the user's CWD.
 */
function resolveSwaggerAssetsDir(): string {
  const require = createRequire(fileURLToPath(import.meta.url));
  // `swagger-ui-dist/package.json` is guaranteed to exist; `dirname` gives
  // us the package root, which is also the assets directory.
  const pkgJson = require.resolve('swagger-ui-dist/package.json');
  return path.dirname(pkgJson);
}

/**
 * Build the Swagger UI HTML shell. Loads CSS and JS from our own
 * `/assets/` route — no external network calls.
 */
function buildSwaggerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pillar API Documentation</title>
  <link rel="stylesheet" href="/assets/swagger-ui.css">
  <style>
    body { margin: 0; padding: 0; }
    #swagger-ui { max-width: 1200px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/assets/swagger-ui-bundle.js"></script>
  <script src="/assets/swagger-ui-standalone-preset.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout: 'BaseLayout'
    });
  </script>
</body>
</html>`;
}
