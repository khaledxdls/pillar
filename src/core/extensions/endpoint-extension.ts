import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourcePath } from '../../utils/resolve-resource-path.js';
import type { Stack } from '../../utils/constants.js';

interface EndpointDefinition {
  method: string;
  path: string;
  handlerName: string;
}

interface EndpointResult {
  operations: FileOperation[];
  modifiedFiles: string[];
}

/**
 * Parse an endpoint string like "GET /users/:id/posts" into a definition.
 */
export function parseEndpointDef(raw: string, resourceName?: string): EndpointDefinition {
  const parts = raw.trim().split(/\s+/);
  const method = (parts[0] ?? 'GET').toUpperCase();
  let routePath = parts[1] ?? '/';

  // Derive handler name from method + path segments (before stripping prefix)
  const segments = routePath
    .split('/')
    .filter((s) => s && !s.startsWith(':'))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  const handlerName = method.toLowerCase() + segments.join('');

  // Strip the resource name prefix from the path to avoid duplication
  // e.g., "/users/:id/posts" on the user router becomes "/:id/posts"
  if (resourceName) {
    const prefix = `/${resourceName}s`;
    if (routePath.startsWith(prefix)) {
      routePath = routePath.slice(prefix.length) || '/';
    }
  }

  return { method, path: routePath, handlerName };
}

/**
 * Add an endpoint to a resource's controller and routes files.
 */
export async function addEndpointToResource(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  endpoint: EndpointDefinition,
  purpose: string,
): Promise<EndpointResult> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const stack = config.project.stack;
  const basePath = resolveResourcePath(config.project.architecture, resourceName);
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  // Add method to controller
  const controllerPath = path.join(projectRoot, basePath, `${resourceName}.controller.${ext}`);
  if (await fs.pathExists(controllerPath)) {
    const result = await injectControllerMethod(controllerPath, projectRoot, endpoint, purpose, isTS, stack);
    if (result) {
      operations.push(result.operation);
      modifiedFiles.push(result.relativePath);
    }
  }

  // Add route to routes file (not needed for NestJS — decorators handle routing)
  if (stack !== 'nestjs') {
    const routesPath = path.join(projectRoot, basePath, `${resourceName}.routes.${ext}`);
    if (await fs.pathExists(routesPath)) {
      const result = await injectRouteLine(routesPath, projectRoot, endpoint, stack, resourceName);
      if (result) {
        operations.push(result.operation);
        modifiedFiles.push(result.relativePath);
      }
    }
  }

  return { operations, modifiedFiles };
}

async function injectControllerMethod(
  controllerPath: string,
  projectRoot: string,
  endpoint: EndpointDefinition,
  purpose: string,
  isTS: boolean,
  stack: Stack,
): Promise<{ operation: FileOperation; relativePath: string } | null> {
  const content = await fs.readFile(controllerPath, 'utf-8');
  const previousContent = content;

  const lastBrace = content.lastIndexOf('}');
  if (lastBrace === -1) return null;

  const newMethod = buildControllerMethod(endpoint, purpose, isTS, stack);
  const updated = content.slice(0, lastBrace) + newMethod + '\n' + content.slice(lastBrace);

  await fs.writeFile(controllerPath, updated, 'utf-8');
  const relativePath = path.relative(projectRoot, controllerPath);
  return {
    operation: { type: 'modify', path: relativePath, previousContent },
    relativePath,
  };
}

function buildControllerMethod(
  endpoint: EndpointDefinition,
  purpose: string,
  isTS: boolean,
  stack: Stack,
): string {
  if (stack === 'nestjs') {
    const decoratorMap: Record<string, string> = {
      GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete',
    };
    const decorator = decoratorMap[endpoint.method] ?? 'Get';
    return [
      '',
      `  // ${purpose}`,
      `  @${decorator}('${endpoint.path}')`,
      `  async ${endpoint.handlerName}() {`,
      `    // TODO: implement ${endpoint.method} ${endpoint.path}`,
      `    return { message: "not implemented" };`,
      `  }`,
    ].join('\n');
  }

  if (stack === 'hono') {
    const paramType = isTS ? 'c: Context' : 'c';
    return [
      '',
      `  // ${purpose}`,
      `  async ${endpoint.handlerName}(${paramType}) {`,
      `    // TODO: implement ${endpoint.method} ${endpoint.path}`,
      `    return c.json({ message: "not implemented" });`,
      `  }`,
    ].join('\n');
  }

  // Express / Fastify — both use req, res
  const reqType = isTS ? 'req: Request' : 'req';
  const resType = isTS ? 'res: Response' : 'res';
  return [
    '',
    `  // ${purpose}`,
    `  async ${endpoint.handlerName}(${reqType}, ${resType}) {`,
    `    // TODO: implement ${endpoint.method} ${endpoint.path}`,
    `    res.json({ message: "not implemented" });`,
    `  }`,
  ].join('\n');
}

async function injectRouteLine(
  routesPath: string,
  projectRoot: string,
  endpoint: EndpointDefinition,
  stack: Stack,
  resourceName: string,
): Promise<{ operation: FileOperation; relativePath: string } | null> {
  const content = await fs.readFile(routesPath, 'utf-8');
  const previousContent = content;
  const methodLower = endpoint.method.toLowerCase();
  const camelName = resourceName.charAt(0).toLowerCase() + resourceName.slice(1);

  let routeLine: string;

  switch (stack) {
    case 'fastify':
      routeLine = `  app.${methodLower}('/${camelName}s${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      break;
    case 'hono':
      routeLine = `${camelName}Routes.${methodLower}('${endpoint.path}', (c) => controller.${endpoint.handlerName}(c));`;
      break;
    default:
      // Express
      routeLine = `router.${methodLower}('${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      break;
  }

  // Insert before the last export or at end of file
  const exportIndex = content.lastIndexOf('export');
  let updated: string;

  if (exportIndex !== -1) {
    updated = content.slice(0, exportIndex) + routeLine + '\n\n' + content.slice(exportIndex);
  } else {
    updated = content + `\n${routeLine}\n`;
  }

  await fs.writeFile(routesPath, updated, 'utf-8');
  const relativePath = path.relative(projectRoot, routesPath);
  return {
    operation: { type: 'modify', path: relativePath, previousContent },
    relativePath,
  };
}
