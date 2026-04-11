import path from 'node:path';
import fs from 'fs-extra';
import { PILLAR_DIR, CONFIG_FILE } from './constants.js';

/**
 * Walk upward from `startDir` to find the nearest directory
 * containing a pillar.config.json. Returns null if none found.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  let current = path.resolve(startDir);

  while (true) {
    const configPath = path.join(current, CONFIG_FILE);
    if (await fs.pathExists(configPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

/**
 * Ensure the .pillar directory exists within the project root.
 */
export async function ensurePillarDir(projectRoot: string): Promise<string> {
  const pillarDir = path.join(projectRoot, PILLAR_DIR);
  await fs.ensureDir(pillarDir);
  return pillarDir;
}

/**
 * Recursively read a directory tree, returning relative paths.
 * Skips node_modules, .git, dist, and the .pillar directory itself.
 */
export async function readDirectoryTree(
  rootDir: string,
  relativeTo?: string,
): Promise<TreeEntry[]> {
  const base = relativeTo ?? rootDir;
  const entries: TreeEntry[] = [];
  const IGNORED = new Set(['node_modules', '.git', 'dist', '.pillar', 'coverage', '.next']);

  const items = await fs.readdir(rootDir, { withFileTypes: true });
  const sorted = items.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const item of sorted) {
    if (IGNORED.has(item.name) || item.name.startsWith('.')) continue;

    const fullPath = path.join(rootDir, item.name);
    const relPath = path.relative(base, fullPath);

    if (item.isDirectory()) {
      const children = await readDirectoryTree(fullPath, base);
      entries.push({ name: item.name, relativePath: relPath + '/', type: 'directory', children });
    } else {
      entries.push({ name: item.name, relativePath: relPath, type: 'file' });
    }
  }

  return entries;
}

export interface TreeEntry {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  children?: TreeEntry[];
}

/**
 * Convert a flat list of relative paths to a nested TreeEntry structure.
 */
export function pathsToTree(paths: string[]): TreeEntry[] {
  const root: TreeEntry[] = [];

  for (const p of paths.sort()) {
    const parts = p.split('/').filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;
      const isDir = p.endsWith('/') ? true : !isLast;
      const relPath = parts.slice(0, i + 1).join('/') + (isDir ? '/' : '');

      let existing = current.find((e) => e.name === part);
      if (!existing) {
        existing = {
          name: part,
          relativePath: relPath,
          type: isDir ? 'directory' : 'file',
          ...(isDir ? { children: [] } : {}),
        };
        current.push(existing);
      }

      if (isDir && existing.children) {
        current = existing.children;
      }
    }
  }

  return root;
}
