/**
 * Plugin system public contracts.
 *
 * A plugin extends Pillar without forking core. The host calls into plugin
 * hooks during well-defined lifecycle points; plugins return typed payloads
 * that the host composes with its built-in behaviour. Plugins never touch
 * the filesystem directly — they return `GeneratedFile` descriptors and the
 * host is responsible for writing / map registration / history.
 *
 * Versioning: the `apiVersion` field is checked on load so we can evolve
 * the hook surface without silently breaking third-party plugins.
 */

import type { PillarConfig } from '../config/index.js';

export const PLUGIN_API_VERSION = 1;

export interface GeneratedFile {
  relativePath: string;
  content: string;
  purpose: string;
}

export interface PluginContext {
  projectRoot: string;
  config: PillarConfig;
}

export interface ResourceHookInput {
  resourceName: string;
  generatedFiles: GeneratedFile[];
}

/**
 * The plugin interface. Every hook is optional — a plugin implements only
 * what it extends. Hooks are `async`-friendly so plugins can read the
 * filesystem, call external services, or run codegen libraries.
 */
export interface PillarPlugin {
  /** Stable identifier, used in logs and config opt-outs. kebab-case. */
  name: string;
  /** Semver string of the plugin itself. */
  version: string;
  /** Which plugin API this plugin targets. Checked at load time. */
  apiVersion: number;

  /** Called once at registration time — plugin can throw to refuse loading. */
  init?(ctx: PluginContext): void | Promise<void>;

  /**
   * Called after the core resource generator produces its files, before
   * anything is written to disk. Plugin returns zero or more additional
   * files (e.g., a `.prisma` schema, a swagger stub, docs, fixtures).
   */
  onResourceGenerated?(
    ctx: PluginContext,
    input: ResourceHookInput,
  ): GeneratedFile[] | Promise<GeneratedFile[]>;

  /**
   * Transform a generated file before it's written. Useful for codemods,
   * linter auto-fixes, header injection, etc. Return the file unchanged if
   * no transform applies.
   */
  transformGeneratedFile?(
    ctx: PluginContext,
    file: GeneratedFile,
  ): GeneratedFile | Promise<GeneratedFile>;

  /**
   * Called after `pillar init` finishes scaffolding. Receives the list of
   * files the scaffolder produced. Plugin may return additional files
   * (e.g., CI configs, docker-compose, editor settings).
   */
  onProjectInit?(
    ctx: PluginContext,
    files: GeneratedFile[],
  ): GeneratedFile[] | Promise<GeneratedFile[]>;
}

export class PluginLoadError extends Error {
  constructor(pluginId: string, reason: string) {
    super(`Failed to load plugin "${pluginId}": ${reason}`);
    this.name = 'PluginLoadError';
  }
}
