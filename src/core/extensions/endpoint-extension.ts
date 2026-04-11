import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { FileOperation } from '../history/types.js';

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
export function parseEndpointDef(raw: string): EndpointDefinition {
  const parts = raw.trim().split(/\s+/);
  const method = (parts[0] ?? 'GET').toUpperCase();
  const routePath = parts[1] ?? '/';

  // Derive handler name from method + path segments
  const segments = routePath
    .split('/')
    .filter((s) => s && !s.startsWith(':'))
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1));
  const handlerName = method.toLowerCase() + segments.join('');

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
  const basePath = resolveResourcePath(config, resourceName);
  const operations: FileOperation[] = [];
  const modifiedFiles: string[] = [];

  // Add method to controller
  const controllerPath = path.join(projectRoot, basePath, `${resourceName}.controller.${ext}`);
  if (await fs.pathExists(controllerPath)) {
    const content = await fs.readFile(controllerPath, 'utf-8');
    const previousContent = content;

    // Insert new method before the closing brace of the class
    const lastBrace = content.lastIndexOf('}');
    if (lastBrace !== -1) {
      const reqType = isTS ? 'req: Request' : 'req';
      const resType = isTS ? 'res: Response' : 'res';
      const newMethod = [
        '',
        `  // ${purpose}`,
        `  async ${endpoint.handlerName}(${reqType}, ${resType}) {`,
        `    // TODO: implement ${endpoint.method} ${endpoint.path}`,
        `    res.json({ message: "not implemented" });`,
        `  }`,
      ].join('\n');

      const updated = content.slice(0, lastBrace) + newMethod + '\n' + content.slice(lastBrace);
      await fs.writeFile(controllerPath, updated, 'utf-8');
      operations.push({ type: 'modify', path: path.relative(projectRoot, controllerPath), previousContent });
      modifiedFiles.push(path.relative(projectRoot, controllerPath));
    }
  }

  // Add route to routes file
  const routesPath = path.join(projectRoot, basePath, `${resourceName}.routes.${ext}`);
  if (await fs.pathExists(routesPath)) {
    const content = await fs.readFile(routesPath, 'utf-8');
    const previousContent = content;

    const methodLower = endpoint.method.toLowerCase();
    const routeLine = `router.${methodLower}('${endpoint.path}', controller.${endpoint.handlerName});`;

    // Insert before the last export or at end of file
    const exportIndex = content.lastIndexOf('export');
    if (exportIndex !== -1) {
      const updated = content.slice(0, exportIndex) + routeLine + '\n\n' + content.slice(exportIndex);
      await fs.writeFile(routesPath, updated, 'utf-8');
    } else {
      await fs.appendFile(routesPath, `\n${routeLine}\n`);
    }

    operations.push({ type: 'modify', path: path.relative(projectRoot, routesPath), previousContent });
    modifiedFiles.push(path.relative(projectRoot, routesPath));
  }

  return { operations, modifiedFiles };
}

function resolveResourcePath(config: PillarConfig, name: string): string {
  switch (config.project.architecture) {
    case 'feature-first':
      return `src/features/${name}`;
    case 'layered':
      return 'src';
    case 'modular':
      return `src/modules/${name}`;
    default:
      return `src/features/${name}`;
  }
}
