import type { Architecture } from './constants.js';

/**
 * Maps file suffixes to layered architecture subdirectories.
 * Shared between resource generation, relation injection, and any module
 * that needs to locate a file by kind inside a layered project.
 */
export const LAYERED_DIRS: Record<string, string> = {
  model: 'models',
  repository: 'repositories',
  service: 'services',
  controller: 'controllers',
  routes: 'routes',
  validator: 'validators',
  types: 'types',
  test: 'tests',
};

/**
 * Resolve the base directory path for a resource based on the architecture.
 * Shared utility to avoid duplication across modules.
 */
export function resolveResourcePath(architecture: Architecture, resourceName: string): string {
    switch (architecture) {
        case 'feature-first':
            return `src/features/${resourceName}`;
        case 'layered':
            return 'src';
        case 'modular':
            return `src/modules/${resourceName}`;
        default:
            return `src/features/${resourceName}`;
    }
}

/**
 * Resolve the full relative path to a specific resource file in any architecture.
 * For layered architecture, files live in `src/<kind-plural>/<resource>.<suffix>.<ext>`.
 * For feature-first/modular, files live alongside each other in the resource directory.
 */
export function resolveResourceFilePath(
  architecture: Architecture,
  resourceName: string,
  suffix: string,
  ext: string,
): string {
  const basePath = resolveResourcePath(architecture, resourceName);
  if (architecture === 'layered') {
    const subDir = LAYERED_DIRS[suffix] ?? suffix;
    return `${basePath}/${subDir}/${resourceName}.${suffix}.${ext}`;
  }
  return `${basePath}/${resourceName}.${suffix}.${ext}`;
}
