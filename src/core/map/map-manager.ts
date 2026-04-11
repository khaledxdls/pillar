import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { ProjectMap, MapNode, MapValidationResult } from './types.js';
import { readDirectoryTree, type TreeEntry } from '../../utils/fs.js';
import {
  PILLAR_DIR,
  PILLAR_MAP_JSON_PATH,
  PILLAR_MAP_MD_PATH,
} from '../../utils/constants.js';

export class MapManager {
  private readonly projectRoot: string;
  private readonly mapJsonPath: string;
  private readonly mapMdPath: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.mapJsonPath = path.join(projectRoot, PILLAR_MAP_JSON_PATH);
    this.mapMdPath = path.join(projectRoot, PILLAR_MAP_MD_PATH);
  }

  /**
   * Create the initial project map from config.
   */
  async initialize(config: PillarConfig, structure: Record<string, MapNode>): Promise<ProjectMap> {
    const now = new Date().toISOString().split('T')[0]!;
    const map: ProjectMap = {
      meta: {
        name: config.project.name,
        stack: config.project.stack,
        language: config.project.language,
        architecture: config.project.architecture,
        created: now,
        lastUpdated: now,
      },
      structure,
    };

    await this.save(map, config.map.format);
    return map;
  }

  /**
   * Load the project map from disk.
   */
  async load(): Promise<ProjectMap | null> {
    if (!(await fs.pathExists(this.mapJsonPath))) {
      return null;
    }
    return fs.readJson(this.mapJsonPath) as Promise<ProjectMap>;
  }

  /**
   * Save the map to disk in the configured formats.
   */
  async save(map: ProjectMap, formats: readonly string[] = ['json', 'markdown']): Promise<void> {
    const pillarDir = path.join(this.projectRoot, PILLAR_DIR);
    await fs.ensureDir(pillarDir);

    map.meta.lastUpdated = new Date().toISOString().split('T')[0]!;

    if (formats.includes('json')) {
      await fs.writeJson(this.mapJsonPath, map, { spaces: 2 });
    }
    if (formats.includes('markdown')) {
      const markdown = this.renderMarkdown(map);
      await fs.writeFile(this.mapMdPath, markdown, 'utf-8');
    }
  }

  /**
   * Register a file or directory in the map with its purpose.
   */
  async registerEntry(
    relativePath: string,
    purpose: string,
    options?: { exports?: string[]; depends_on?: string[] },
  ): Promise<void> {
    let map = await this.load();
    if (!map) return;

    const parts = relativePath.split('/').filter(Boolean);
    let current = map.structure;

    // Walk/create the path in the tree
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;

      if (!current[part]) {
        current[part] = {
          purpose: isLast ? purpose : '',
          ...(isLast ? {} : { children: {} }),
        };
      }

      if (isLast) {
        current[part]!.purpose = purpose;
        if (options?.exports) current[part]!.exports = options.exports;
        if (options?.depends_on) current[part]!.depends_on = options.depends_on;
      } else {
        if (!current[part]!.children) {
          current[part]!.children = {};
        }
        current = current[part]!.children!;
      }
    }

    await this.save(map);
  }

  /**
   * Remove an entry from the map.
   */
  async removeEntry(relativePath: string): Promise<boolean> {
    const map = await this.load();
    if (!map) return false;

    const parts = relativePath.split('/').filter(Boolean);
    const parents: Array<{ node: Record<string, MapNode>; key: string }> = [];
    let current = map.structure;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      const isLast = i === parts.length - 1;

      if (!current[part]) return false;

      if (isLast) {
        delete current[part];
        await this.save(map);
        return true;
      }

      parents.push({ node: current, key: part });
      if (!current[part]!.children) return false;
      current = current[part]!.children!;
    }

    return false;
  }

  /**
   * Validate the map against the actual filesystem.
   */
  async validate(): Promise<MapValidationResult> {
    const map = await this.load();
    if (!map) {
      return { unmappedFiles: [], missingFiles: [], valid: false };
    }

    const mappedPaths = this.collectPaths(map.structure, '');
    const actualTree = await readDirectoryTree(path.join(this.projectRoot, 'src'), this.projectRoot);
    const actualPaths = this.flattenTree(actualTree);

    const unmappedFiles = [...actualPaths].filter((p) => !mappedPaths.has(p));
    const missingFiles = [...mappedPaths].filter((p) => !actualPaths.has(p));

    return {
      unmappedFiles,
      missingFiles,
      valid: unmappedFiles.length === 0 && missingFiles.length === 0,
    };
  }

  /**
   * Rebuild the map from filesystem, preserving existing purposes.
   */
  async refresh(config: PillarConfig): Promise<ProjectMap> {
    const existing = await this.load();
    const srcDir = path.join(this.projectRoot, 'src');

    if (!(await fs.pathExists(srcDir))) {
      // Nothing to refresh from, keep or create minimal map
      return existing ?? this.initialize(config, {});
    }

    const tree = await readDirectoryTree(srcDir, this.projectRoot);
    const newStructure = this.treeToMapStructure(tree, existing?.structure ?? {});

    const map: ProjectMap = {
      meta: existing?.meta ?? {
        name: config.project.name,
        stack: config.project.stack,
        language: config.project.language,
        architecture: config.project.architecture,
        created: new Date().toISOString().split('T')[0]!,
        lastUpdated: new Date().toISOString().split('T')[0]!,
      },
      structure: newStructure,
    };

    await this.save(map, config.map.format);
    return map;
  }

  /**
   * Render the map as a markdown tree.
   */
  renderMarkdown(map: ProjectMap): string {
    const lines: string[] = [
      `# Project Map: ${map.meta.name}`,
      '',
      `> Stack: ${map.meta.stack} | Language: ${map.meta.language} | Architecture: ${map.meta.architecture}`,
      `> Last updated: ${map.meta.lastUpdated}`,
      '',
      '```',
    ];

    this.renderTree(map.structure, '', lines);
    lines.push('```', '');
    return lines.join('\n');
  }

  private renderTree(nodes: Record<string, MapNode>, prefix: string, lines: string[]): void {
    const entries = Object.entries(nodes);
    for (let i = 0; i < entries.length; i++) {
      const [name, node] = entries[i]!;
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const isDir = node.children !== undefined;
      const displayName = isDir ? `${name}/` : name;
      const purpose = node.purpose ? `  # ${node.purpose}` : '';

      lines.push(`${prefix}${connector}${displayName}${purpose}`);

      if (node.children) {
        this.renderTree(node.children, prefix + childPrefix, lines);
      }
    }
  }

  private collectPaths(nodes: Record<string, MapNode>, prefix: string): Set<string> {
    const paths = new Set<string>();
    for (const [name, node] of Object.entries(nodes)) {
      const current = prefix ? `${prefix}/${name}` : name;
      if (node.children) {
        paths.add(current + '/');
        const childPaths = this.collectPaths(node.children, current);
        for (const p of childPaths) paths.add(p);
      } else {
        paths.add(current);
      }
    }
    return paths;
  }

  private flattenTree(entries: TreeEntry[], prefix = ''): Set<string> {
    const paths = new Set<string>();
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.type === 'directory') {
        paths.add(rel + '/');
        if (entry.children) {
          const childPaths = this.flattenTree(entry.children, rel);
          for (const p of childPaths) paths.add(p);
        }
      } else {
        paths.add(rel);
      }
    }
    return paths;
  }

  private treeToMapStructure(
    entries: TreeEntry[],
    existing: Record<string, MapNode>,
  ): Record<string, MapNode> {
    const structure: Record<string, MapNode> = {};

    for (const entry of entries) {
      const existingNode = existing[entry.name];
      if (entry.type === 'directory') {
        structure[entry.name] = {
          purpose: existingNode?.purpose ?? '',
          children: this.treeToMapStructure(
            entry.children ?? [],
            existingNode?.children ?? {},
          ),
        };
      } else {
        structure[entry.name] = {
          purpose: existingNode?.purpose ?? '',
          ...(existingNode?.exports ? { exports: existingNode.exports } : {}),
          ...(existingNode?.depends_on ? { depends_on: existingNode.depends_on } : {}),
        };
      }
    }

    return structure;
  }
}
