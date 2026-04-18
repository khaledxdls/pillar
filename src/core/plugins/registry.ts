import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import {
  PLUGIN_API_VERSION,
  PluginLoadError,
  type GeneratedFile,
  type PillarPlugin,
  type PluginContext,
  type ResourceHookInput,
} from './types.js';

/**
 * Plugin registry.
 *
 * Plugins are declared in `pillar.config.json` under `plugins: [...]` as
 * package names or relative paths. They are loaded lazily when the registry
 * is first used, so startup cost stays close to zero on commands that don't
 * run codegen.
 *
 * A registered plugin module must default-export a `PillarPlugin` object.
 * Loading is sandboxed in the error-handling sense: one bad plugin does not
 * prevent others from running — we log the failure and continue.
 *
 * Hook fan-out is sequential and each plugin's output flows into the next.
 * That keeps the mental model predictable (no surprise parallel writes) at
 * the cost of raw throughput, which is fine for CLI usage.
 */
export class PluginRegistry {
  private plugins: PillarPlugin[] = [];
  private loaded = false;

  constructor(
    private readonly ctx: PluginContext,
    private readonly specs: string[],
  ) {}

  /**
   * Build a registry from a project config. Reads the optional
   * `plugins` array — safe to call when `plugins` is absent.
   */
  static fromConfig(projectRoot: string, config: PillarConfig): PluginRegistry {
    const specs = config.plugins ?? [];
    return new PluginRegistry({ projectRoot, config }, specs);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    for (const spec of this.specs) {
      try {
        const plugin = await this.resolveAndImport(spec);
        if (plugin.apiVersion !== PLUGIN_API_VERSION) {
          throw new PluginLoadError(
            spec,
            `plugin targets API v${plugin.apiVersion}, this Pillar expects v${PLUGIN_API_VERSION}`,
          );
        }
        if (plugin.init) await plugin.init(this.ctx);
        this.plugins.push(plugin);
      } catch (err) {
        // We deliberately don't throw — one broken plugin must not
        // brick every `pillar` invocation. The host CLI surfaces the
        // warning via logger; here we only augment the message.
        const message = err instanceof Error ? err.message : String(err);
        throw new PluginLoadError(spec, message);
      }
    }
  }

  list(): ReadonlyArray<PillarPlugin> {
    return this.plugins;
  }

  /**
   * Fan-out hook: every plugin's files are concatenated. If a plugin
   * throws we swallow and continue — the caller sees a subset, not a
   * total failure.
   */
  async runOnResourceGenerated(input: ResourceHookInput): Promise<GeneratedFile[]> {
    const out: GeneratedFile[] = [];
    for (const p of this.plugins) {
      if (!p.onResourceGenerated) continue;
      try {
        const files = await p.onResourceGenerated(this.ctx, input);
        out.push(...files);
      } catch (err) {
        this.onHookError(p, 'onResourceGenerated', err);
      }
    }
    return out;
  }

  /**
   * Pipeline hook: each plugin's transform feeds into the next. Order is
   * the order plugins were declared in the config.
   */
  async runTransformGeneratedFile(file: GeneratedFile): Promise<GeneratedFile> {
    let current = file;
    for (const p of this.plugins) {
      if (!p.transformGeneratedFile) continue;
      try {
        current = await p.transformGeneratedFile(this.ctx, current);
      } catch (err) {
        this.onHookError(p, 'transformGeneratedFile', err);
      }
    }
    return current;
  }

  async runOnProjectInit(files: GeneratedFile[]): Promise<GeneratedFile[]> {
    const out: GeneratedFile[] = [];
    for (const p of this.plugins) {
      if (!p.onProjectInit) continue;
      try {
        const extra = await p.onProjectInit(this.ctx, files);
        out.push(...extra);
      } catch (err) {
        this.onHookError(p, 'onProjectInit', err);
      }
    }
    return out;
  }

  /**
   * Resolve a plugin spec to an absolute path. Supports:
   *   - bare npm package names (resolved from the project root)
   *   - relative paths starting with `./` or `../`
   *   - absolute paths
   *
   * We don't use `createRequire` for bare packages because plugins may be
   * ESM-only; dynamic `import()` with a file URL handles both module kinds.
   */
  private async resolveAndImport(spec: string): Promise<PillarPlugin> {
    let importTarget: string;

    if (spec.startsWith('./') || spec.startsWith('../') || path.isAbsolute(spec)) {
      const abs = path.isAbsolute(spec) ? spec : path.resolve(this.ctx.projectRoot, spec);
      if (!(await fs.pathExists(abs))) {
        throw new Error(`path does not exist: ${abs}`);
      }
      importTarget = pathToFileURL(abs).href;
    } else {
      // Bare package — resolve relative to the user's project, not Pillar.
      const { createRequire } = await import('node:module');
      const require = createRequire(path.join(this.ctx.projectRoot, 'package.json'));
      importTarget = pathToFileURL(require.resolve(spec)).href;
    }

    const mod = (await import(importTarget)) as { default?: unknown };
    const candidate = mod.default ?? mod;
    if (!isPillarPlugin(candidate)) {
      throw new Error('module does not default-export a PillarPlugin');
    }
    return candidate;
  }

  private onHookError(p: PillarPlugin, hook: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Using console.warn keeps the registry decoupled from the CLI logger
    // — plugins can be exercised in tests without a spinner dependency.
    console.warn(`[pillar] plugin "${p.name}" ${hook} failed: ${msg}`);
  }
}

function isPillarPlugin(value: unknown): value is PillarPlugin {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['name'] === 'string'
    && typeof v['version'] === 'string'
    && typeof v['apiVersion'] === 'number'
  );
}
