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
  const clone = structuredClone(config);
  const allKeys = keyPath.split('.');
  const lastKey = allKeys.pop();
  if (!lastKey) return clone;

  // Validate every key segment against prototype pollution
  for (const k of [...allKeys, lastKey]) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
      throw new InvalidConfigError(`Key "${k}" is not allowed in config paths`);
    }
  }

  // Only allow keys that are known top-level config sections
  const ALLOWED_SECTIONS = new Set(['project', 'database', 'generation', 'map', 'extras']);
  const topKey = allKeys[0] ?? lastKey;
  if (!ALLOWED_SECTIONS.has(topKey)) {
    throw new InvalidConfigError(`Unknown config section: "${topKey}"`);
  }

  let current: Record<string, unknown> = clone as unknown as Record<string, unknown>;
  for (const key of allKeys) {
    const next = Object.getOwnPropertyDescriptor(current, key);
    if (!next || typeof next.value !== 'object' || next.value === null) {
      const obj = Object.create(null) as Record<string, unknown>;
      current[key] = obj;
    }
    current = current[key] as Record<string, unknown>;
  }

  current[lastKey] = value;

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
