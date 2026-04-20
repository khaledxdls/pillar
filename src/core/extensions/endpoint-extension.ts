import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { resolveResourceFilePath } from '../../utils/resolve-resource-path.js';
import type { Stack } from '../../utils/constants.js';
import { toCamelCase, toPascalCase, pluralizeResource } from '../../utils/naming.js';
import { addMethodToClass, addModuleStatement, appendStatementToFunction } from '../ast/index.js';

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
 * The resource prefix (e.g. `/users`) is stripped because routers are
 * already mounted under that prefix.
 */
export function parseEndpointDef(raw: string, resourceName?: string): EndpointDefinition {
  const parts = raw.trim().split(/\s+/);
  const method = (parts[0] ?? 'GET').toUpperCase();
  let routePath = parts[1] ?? '/';

  const segments = routePath
    .split('/')
    .filter((s) => s && !s.startsWith(':'))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  const handlerName = method.toLowerCase() + segments.join('');

  if (resourceName) {
    const prefix = `/${pluralizeResource(resourceName)}`;
    if (routePath.startsWith(prefix)) {
      routePath = routePath.slice(prefix.length) || '/';
    }
  }

  return { method, path: routePath, handlerName };
}

/**
 * Add a custom endpoint to a resource.
 *
 * Injects the handler method into the controller class, and for non-NestJS
 * stacks registers the route in the routes file. All edits are AST-based
 * and idempotent — re-running with the same inputs is a no-op.
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
  const arch = config.project.architecture;
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  const controllerPath = path.join(projectRoot, resolveResourceFilePath(arch, resourceName, 'controller', ext));
  if (await fs.pathExists(controllerPath)) {
    const result = await injectControllerMethod(controllerPath, projectRoot, resourceName, endpoint, purpose, isTS, stack);
    if (result) { operations.push(result.operation); modifiedFiles.push(result.relativePath); }
  }

  // NestJS registers routes via the `@Get/@Post/…` decorators on the
  // controller method itself — no separate routes file.
  if (stack !== 'nestjs') {
    const routesPath = path.join(projectRoot, resolveResourceFilePath(arch, resourceName, 'routes', ext));
    if (await fs.pathExists(routesPath)) {
      const result = await injectRouteStatement(routesPath, projectRoot, endpoint, stack, resourceName);
      if (result) { operations.push(result.operation); modifiedFiles.push(result.relativePath); }
    }
  }

  return { operations, modifiedFiles };
}

async function injectControllerMethod(
  controllerPath: string,
  projectRoot: string,
  resourceName: string,
  endpoint: EndpointDefinition,
  purpose: string,
  isTS: boolean,
  stack: Stack,
): Promise<{ operation: FileOperation; relativePath: string } | null> {
  const previousContent = await fs.readFile(controllerPath, 'utf-8');
  const className = `${toPascalCase(resourceName)}Controller`;
  const methodCode = buildControllerMethod(endpoint, purpose, isTS, stack);

  const updated = addMethodToClass(previousContent, className, methodCode);
  if (updated === null || updated === previousContent) return null;

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
  const todo = `// TODO: implement ${endpoint.method} ${endpoint.path}`;
  const commentHeader = `// ${purpose}`;

  if (stack === 'nestjs') {
    const decoratorMap: Record<string, string> = {
      GET: 'Get', POST: 'Post', PUT: 'Put', PATCH: 'Patch', DELETE: 'Delete',
    };
    const decorator = decoratorMap[endpoint.method] ?? 'Get';
    return [
      commentHeader,
      `@${decorator}('${endpoint.path}')`,
      `async ${endpoint.handlerName}() {`,
      `  ${todo}`,
      `  return { message: 'not implemented' };`,
      `}`,
    ].join('\n');
  }

  if (stack === 'hono') {
    const param = isTS ? 'c: Context' : 'c';
    return [
      commentHeader,
      `async ${endpoint.handlerName}(${param}) {`,
      `  ${todo}`,
      `  return c.json({ message: 'not implemented' });`,
      `}`,
    ].join('\n');
  }

  if (stack === 'fastify') {
    const req = isTS ? 'req: FastifyRequest' : 'req';
    const res = isTS ? 'res: FastifyReply' : 'res';
    return [
      commentHeader,
      `async ${endpoint.handlerName}(${req}, ${res}) {`,
      `  ${todo}`,
      `  return res.send({ message: 'not implemented' });`,
      `}`,
    ].join('\n');
  }

  // Express (default) + Next.js fall through here — Next.js doesn't
  // actually use generated controllers (App Router handler is written
  // directly by the resource generator) but keep the shape consistent.
  const req = isTS ? 'req: Request' : 'req';
  const res = isTS ? 'res: Response' : 'res';
  return [
    commentHeader,
    `async ${endpoint.handlerName}(${req}, ${res}) {`,
    `  ${todo}`,
    `  res.json({ message: 'not implemented' });`,
    `}`,
  ].join('\n');
}

async function injectRouteStatement(
  routesPath: string,
  projectRoot: string,
  endpoint: EndpointDefinition,
  stack: Stack,
  resourceName: string,
): Promise<{ operation: FileOperation; relativePath: string } | null> {
  const previousContent = await fs.readFile(routesPath, 'utf-8');
  const methodLower = endpoint.method.toLowerCase();
  const camelName = toCamelCase(resourceName);
  const pluralPath = pluralizeResource(camelName);

  let statement: string;
  let updated: string;

  switch (stack) {
    case 'fastify':
      // Fastify routes live inside the exported `${name}Routes` function body.
      // AST insertion guarantees the new statement lands before the closing
      // brace even if the body already contains nested braces/comments.
      statement = `app.${methodLower}('/${pluralPath}${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      {
        const result = appendStatementToFunction(previousContent, `${camelName}Routes`, statement);
        if (result === null) return null;
        updated = result;
      }
      break;

    case 'hono':
      statement = `${camelName}Routes.${methodLower}('${endpoint.path}', (c) => controller.${endpoint.handlerName}(c));`;
      updated = addModuleStatement(previousContent, statement);
      break;

    default:
      // Express: must insert before the trailing `export { router as … }`
      // so the export remains the last statement in the module.
      statement = `router.${methodLower}('${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      updated = addModuleStatement(previousContent, statement, { beforeLastExport: true });
      break;
  }

  if (updated === previousContent) return null;

  await fs.writeFile(routesPath, updated, 'utf-8');
  const relativePath = path.relative(projectRoot, routesPath);
  return {
    operation: { type: 'modify', path: relativePath, previousContent },
    relativePath,
  };
}
