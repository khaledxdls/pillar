import path from 'node:path';
import fs from 'fs-extra';
import { pillarConfigSchema, type PillarConfig } from './schema.js';
import { CONFIG_FILE } from '../../utils/constants.js';
import { ConfigNotFoundError, InvalidConfigError } from '../../utils/errors.js';

/**
 * Load and validate pillar.config.json from the given project root.
 */
export async function loadConfig(projectRoot: string): Promise<PillarConfig> {
  const configPath = path.join(projectRoot, CONFIG_FILE);

  if (!(await fs.pathExists(configPath))) {
    throw new ConfigNotFoundError(configPath);
  }

  const raw = await fs.readJson(configPath);
  const result = pillarConfigSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new InvalidConfigError(`\n${issues}`);
  }

  return result.data;
}

/**
 * Write a config object to pillar.config.json.
 */
export async function writeConfig(projectRoot: string, config: PillarConfig): Promise<void> {
  const configPath = path.join(projectRoot, CONFIG_FILE);
  await fs.writeJson(configPath, config, { spaces: 2 });
}

/**
 * Read a nested value from the config using dot notation.
 * Returns undefined if the path does not exist.
 */
export function getConfigValue(config: PillarConfig, keyPath: string): unknown {
  const keys = keyPath.split('.');
  let current: unknown = config;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Set a nested value in the config using dot notation.
 * Returns a new config object (does not mutate the original).
 */
export function setConfigValue(config: PillarConfig, keyPath: string, value: unknown): PillarConfig {
  // Build a plain object with the nested value, then deep-merge into the clone.
  // This avoids any bracket-notation assignment on user-controlled keys,
  // which CodeQL flags as prototype-polluting.
  const allKeys = keyPath.split('.');

  // Allowlist: only known config sections are accepted
  const ALLOWED_SECTIONS = new Set(['project', 'database', 'generation', 'map', 'extras']);
  const topKey = allKeys[0];
  if (!topKey || !ALLOWED_SECTIONS.has(topKey)) {
    throw new InvalidConfigError(`Unknown config section: "${topKey ?? keyPath}"`);
  }

  // Build the nested patch object from the leaf up (no bracket assignment on user keys)
  let patch: unknown = value;
  for (let i = allKeys.length - 1; i >= 0; i--) {
    const key = allKeys[i]!;
    const wrapper = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(wrapper, key, {
      value: patch,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    patch = wrapper;
  }

  // Deep-merge the patch into a clone of the config using only own-property iteration
  const clone = structuredClone(config);
  deepMerge(clone as unknown as Record<string, unknown>, patch as Record<string, unknown>);

  // Re-validate after mutation
  const result = pillarConfigSchema.safeParse(clone);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new InvalidConfigError(`Cannot set "${keyPath}" to ${JSON.stringify(value)}:\n${issues}`);
  }

  return result.data;
}

/**
 * Recursively merge `source` into `target`, using only own enumerable properties.
 * Protects against prototype pollution by skipping dangerous keys and using
 * Object.hasOwn + Object.defineProperty instead of bracket assignment.
 */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.hasOwn(source, key)) continue;

    const sourceVal = source[key];
    const targetVal = Object.hasOwn(target, key) ? target[key] : undefined;

    if (
      sourceVal !== null && typeof sourceVal === 'object' && !Array.isArray(sourceVal) &&
      targetVal !== null && typeof targetVal === 'object' && !Array.isArray(targetVal)
    ) {
      deepMerge(targetVal as Record<string, unknown>, sourceVal as Record<string, unknown>);
    } else {
      Object.defineProperty(target, key, {
        value: sourceVal,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
}
