import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';
import { PlanBuilder, PlanExecutor } from '../plan/index.js';
import type { Plan } from '../plan/index.js';
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
 * Compute the Plan for adding an endpoint. No I/O writes.
 *
 * Covers controller-method injection (all stacks) and route-registration
 * injection (all stacks except NestJS, which registers via decorators).
 */
export async function planEndpointExtension(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  endpoint: EndpointDefinition,
  purpose: string,
  command: string,
): Promise<Plan> {
  const ext = config.project.language === 'typescript' ? 'ts' : 'js';
  const isTS = config.project.language === 'typescript';
  const stack = config.project.stack;
  const arch = config.project.architecture;
  const builder = new PlanBuilder(projectRoot, command);

  const controllerRel = resolveResourceFilePath(arch, resourceName, 'controller', ext);
  const controllerFull = path.join(projectRoot, controllerRel);
  if (await fs.pathExists(controllerFull)) {
    const previous = await fs.readFile(controllerFull, 'utf-8');
    const className = `${toPascalCase(resourceName)}Controller`;
    const methodCode = buildControllerMethod(endpoint, purpose, isTS, stack);
    const updated = addMethodToClass(previous, className, methodCode);
    if (updated !== null && updated !== previous) {
      await builder.modify(controllerRel, updated, `add ${endpoint.method} ${endpoint.path} handler`);
    }
  }

  if (stack !== 'nestjs') {
    const routesRel = resolveResourceFilePath(arch, resourceName, 'routes', ext);
    const routesFull = path.join(projectRoot, routesRel);
    if (await fs.pathExists(routesFull)) {
      const previous = await fs.readFile(routesFull, 'utf-8');
      const updated = buildRoutesUpdate(previous, endpoint, stack, resourceName);
      if (updated !== null && updated !== previous) {
        await builder.modify(routesRel, updated, `register ${endpoint.method} ${endpoint.path}`);
      }
    }
  }

  return builder.build();
}

export async function addEndpointToResource(
  projectRoot: string,
  config: PillarConfig,
  resourceName: string,
  endpoint: EndpointDefinition,
  purpose: string,
): Promise<EndpointResult> {
  const plan = await planEndpointExtension(
    projectRoot,
    config,
    resourceName,
    endpoint,
    purpose,
    `add endpoint ${resourceName} ${endpoint.method} ${endpoint.path}`,
  );
  const { operations, touched } = await new PlanExecutor(projectRoot).execute(plan);
  return { operations, modifiedFiles: touched };
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

function buildRoutesUpdate(
  previousContent: string,
  endpoint: EndpointDefinition,
  stack: Stack,
  resourceName: string,
): string | null {
  const methodLower = endpoint.method.toLowerCase();
  const camelName = toCamelCase(resourceName);
  const pluralPath = pluralizeResource(camelName);

  switch (stack) {
    case 'fastify': {
      // Fastify routes live inside the exported `${name}Routes` function body.
      const statement = `app.${methodLower}('/${pluralPath}${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      return appendStatementToFunction(previousContent, `${camelName}Routes`, statement);
    }
    case 'hono': {
      const statement = `${camelName}Routes.${methodLower}('${endpoint.path}', (c) => controller.${endpoint.handlerName}(c));`;
      return addModuleStatement(previousContent, statement);
    }
    default: {
      // Express: insert before the trailing `export { router … }` so the
      // export remains the last statement in the module.
      const statement = `router.${methodLower}('${endpoint.path}', (req, res) => controller.${endpoint.handlerName}(req, res));`;
      return addModuleStatement(previousContent, statement, { beforeLastExport: true });
    }
  }
}
