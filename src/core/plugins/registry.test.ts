import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import { PluginRegistry } from './registry.js';
import { PLUGIN_API_VERSION } from './types.js';
import type { PillarConfig } from '../config/index.js';

function makeConfig(plugins: string[]): PillarConfig {
  return {
    project: {
      name: 'test', platform: 'web', category: 'api',
      stack: 'express', language: 'typescript', architecture: 'feature-first',
      packageManager: 'npm',
    },
    database: { type: 'postgres', orm: 'prisma' },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: true, format: ['json'] },
    extras: { docker: false, linting: false, gitHooks: false },
    plugins,
  } as PillarConfig;
}

describe('PluginRegistry', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-plugin-'));
  });

  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('loads a relative-path plugin and runs its hooks', async () => {
    const pluginPath = path.join(tmp, 'my-plugin.mjs');
    await fs.writeFile(pluginPath, `
      export default {
        name: 'test-plugin',
        version: '0.0.1',
        apiVersion: ${PLUGIN_API_VERSION},
        onResourceGenerated(_ctx, input) {
          return [{ relativePath: 'extra/' + input.resourceName + '.md', content: '# ' + input.resourceName, purpose: 'docs' }];
        },
        transformGeneratedFile(_ctx, file) {
          return { ...file, content: file.content + '\\n// transformed' };
        },
      };
    `);

    const registry = PluginRegistry.fromConfig(tmp, makeConfig(['./my-plugin.mjs']));
    await registry.load();

    const extras = await registry.runOnResourceGenerated({
      resourceName: 'user',
      generatedFiles: [],
    });
    expect(extras).toHaveLength(1);
    expect(extras[0]!.relativePath).toBe('extra/user.md');

    const transformed = await registry.runTransformGeneratedFile({
      relativePath: 'a.ts', content: 'x', purpose: 'p',
    });
    expect(transformed.content).toContain('// transformed');
  });

  it('rejects plugins with wrong apiVersion', async () => {
    const pluginPath = path.join(tmp, 'bad.mjs');
    await fs.writeFile(pluginPath, `
      export default { name: 'bad', version: '0.0.1', apiVersion: 999 };
    `);
    const registry = PluginRegistry.fromConfig(tmp, makeConfig(['./bad.mjs']));
    await expect(registry.load()).rejects.toThrow(/API v999/);
  });

  it('no-ops when plugins config is absent', async () => {
    const registry = PluginRegistry.fromConfig(tmp, makeConfig([]));
    await registry.load();
    expect(registry.list()).toHaveLength(0);
  });

  it('isolates transform errors (does not throw)', async () => {
    const pluginPath = path.join(tmp, 'throwing.mjs');
    await fs.writeFile(pluginPath, `
      export default {
        name: 'throws', version: '0.0.1', apiVersion: ${PLUGIN_API_VERSION},
        transformGeneratedFile() { throw new Error('boom'); },
      };
    `);
    const registry = PluginRegistry.fromConfig(tmp, makeConfig(['./throwing.mjs']));
    await registry.load();
    const out = await registry.runTransformGeneratedFile({
      relativePath: 'a.ts', content: 'x', purpose: 'p',
    });
    // File passes through unchanged.
    expect(out.content).toBe('x');
  });
});
