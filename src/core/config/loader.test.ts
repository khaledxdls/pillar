import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { loadConfig, writeConfig, getConfigValue, setConfigValue } from './loader.js';
import type { PillarConfig } from './schema.js';

const VALID_CONFIG: PillarConfig = {
  project: {
    name: 'test-app',
    platform: 'web',
    category: 'api',
    stack: 'express',
    language: 'typescript',
    architecture: 'feature-first',
    packageManager: 'npm',
  },
  database: { type: 'postgresql', orm: 'prisma' },
  generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
  map: { autoUpdate: true, format: ['json', 'markdown'] },
  extras: { docker: false, linting: false, gitHooks: false },
};

describe('config/loader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('writeConfig + loadConfig', () => {
    it('round-trips a valid config', async () => {
      await writeConfig(tmpDir, VALID_CONFIG);
      const loaded = await loadConfig(tmpDir);
      expect(loaded).toEqual(VALID_CONFIG);
    });

    it('throws ConfigNotFoundError when file is missing', async () => {
      await expect(loadConfig(tmpDir)).rejects.toThrow('pillar.config.json');
    });

    it('throws InvalidConfigError for invalid config', async () => {
      const configPath = path.join(tmpDir, 'pillar.config.json');
      await fs.writeJson(configPath, { project: { name: '' } });
      await expect(loadConfig(tmpDir)).rejects.toThrow();
    });
  });

  describe('getConfigValue', () => {
    it('reads top-level section', () => {
      expect(getConfigValue(VALID_CONFIG, 'project')).toEqual(VALID_CONFIG.project);
    });

    it('reads nested value', () => {
      expect(getConfigValue(VALID_CONFIG, 'project.name')).toBe('test-app');
      expect(getConfigValue(VALID_CONFIG, 'database.orm')).toBe('prisma');
    });

    it('returns undefined for missing path', () => {
      expect(getConfigValue(VALID_CONFIG, 'project.nonexistent')).toBeUndefined();
      expect(getConfigValue(VALID_CONFIG, 'fake.deep.path')).toBeUndefined();
    });
  });

  describe('setConfigValue', () => {
    it('sets a nested value and returns a new config', () => {
      const updated = setConfigValue(VALID_CONFIG, 'project.name', 'new-name');
      expect(updated.project.name).toBe('new-name');
      // Original is not mutated
      expect(VALID_CONFIG.project.name).toBe('test-app');
    });

    it('sets a boolean value', () => {
      const updated = setConfigValue(VALID_CONFIG, 'extras.docker', true);
      expect(updated.extras.docker).toBe(true);
    });

    it('rejects unknown config sections', () => {
      expect(() => setConfigValue(VALID_CONFIG, '__proto__.polluted', 'yes')).toThrow();
      expect(() => setConfigValue(VALID_CONFIG, 'constructor.prototype', 'yes')).toThrow();
      expect(() => setConfigValue(VALID_CONFIG, 'randomSection.key', 'yes')).toThrow();
    });

    it('rejects values that break validation', () => {
      expect(() => setConfigValue(VALID_CONFIG, 'project.name', '')).toThrow();
      expect(() => setConfigValue(VALID_CONFIG, 'project.stack', 'invalid-stack')).toThrow();
    });

    it('prevents prototype pollution via __proto__', () => {
      expect(() => setConfigValue(VALID_CONFIG, '__proto__.isAdmin', true)).toThrow();
      const obj = {} as Record<string, unknown>;
      expect(obj['isAdmin']).toBeUndefined();
    });

    it('prevents prototype pollution via constructor', () => {
      expect(() => setConfigValue(VALID_CONFIG, 'constructor.prototype.isAdmin', true)).toThrow();
    });
  });
});
