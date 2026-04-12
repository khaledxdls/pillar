import type { Architecture } from './constants.js';

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
