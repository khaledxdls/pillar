import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { MapManager } from './map-manager.js';
import type { PillarConfig } from '../config/index.js';

const CONFIG: PillarConfig = {
  project: {
    name: 'test-app',
    platform: 'web',
    category: 'api',
    stack: 'express',
    language: 'typescript',
    architecture: 'feature-first',
    packageManager: 'npm',
  },
  database: { type: 'none', orm: 'none' },
  generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
  map: { autoUpdate: true, format: ['json', 'markdown'] },
  extras: { docker: false, linting: false, gitHooks: false },
};

describe('MapManager', () => {
  let tmpDir: string;
  let manager: MapManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-map-test-'));
    manager = new MapManager(tmpDir);
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('initialize', () => {
    it('creates map files on disk', async () => {
      await manager.initialize(CONFIG, {
        src: { purpose: 'Source code', children: {} },
      });

      const jsonPath = path.join(tmpDir, '.pillar/map.json');
      const mdPath = path.join(tmpDir, '.pillar/map.md');

      expect(await fs.pathExists(jsonPath)).toBe(true);
      expect(await fs.pathExists(mdPath)).toBe(true);
    });

    it('sets correct metadata', async () => {
      const map = await manager.initialize(CONFIG, {});
      expect(map.meta.name).toBe('test-app');
      expect(map.meta.stack).toBe('express');
      expect(map.meta.language).toBe('typescript');
      expect(map.meta.architecture).toBe('feature-first');
    });
  });

  describe('load', () => {
    it('returns null when no map exists', async () => {
      const result = await manager.load();
      expect(result).toBeNull();
    });

    it('loads an initialized map', async () => {
      await manager.initialize(CONFIG, { src: { purpose: 'Source' } });
      const loaded = await manager.load();
      expect(loaded).not.toBeNull();
      expect(loaded!.structure['src']!.purpose).toBe('Source');
    });
  });

  describe('registerEntry', () => {
    it('adds a file to the map', async () => {
      await manager.initialize(CONFIG, {});
      await manager.registerEntry('src/server.ts', 'HTTP server entrypoint');

      const map = await manager.load();
      expect(map!.structure['src']!.children!['server.ts']!.purpose).toBe('HTTP server entrypoint');
    });

    it('adds nested paths, creating intermediate nodes', async () => {
      await manager.initialize(CONFIG, {});
      await manager.registerEntry('src/features/user/user.service.ts', 'User business logic');

      const map = await manager.load();
      const userService = map!.structure['src']!.children!['features']!.children!['user']!.children!['user.service.ts'];
      expect(userService!.purpose).toBe('User business logic');
    });

    it('preserves existing entries when adding new ones', async () => {
      await manager.initialize(CONFIG, {});
      await manager.registerEntry('src/a.ts', 'File A');
      await manager.registerEntry('src/b.ts', 'File B');

      const map = await manager.load();
      expect(map!.structure['src']!.children!['a.ts']!.purpose).toBe('File A');
      expect(map!.structure['src']!.children!['b.ts']!.purpose).toBe('File B');
    });
  });

  describe('removeEntry', () => {
    it('removes an entry and returns true', async () => {
      await manager.initialize(CONFIG, {
        src: { purpose: '', children: { 'a.ts': { purpose: 'File A' } } },
      });

      const removed = await manager.removeEntry('src/a.ts');
      expect(removed).toBe(true);

      const map = await manager.load();
      expect(map!.structure['src']!.children!['a.ts']).toBeUndefined();
    });

    it('returns false for non-existent path', async () => {
      await manager.initialize(CONFIG, {});
      const removed = await manager.removeEntry('src/nonexistent.ts');
      expect(removed).toBe(false);
    });
  });

  describe('renderMarkdown', () => {
    it('produces a valid markdown tree', async () => {
      const map = await manager.initialize(CONFIG, {
        src: {
          purpose: 'Source code',
          children: {
            'server.ts': { purpose: 'HTTP server' },
          },
        },
      });

      const md = manager.renderMarkdown(map);
      expect(md).toContain('# Project Map: test-app');
      expect(md).toContain('src/');
      expect(md).toContain('server.ts');
      expect(md).toContain('# HTTP server');
    });
  });
});
