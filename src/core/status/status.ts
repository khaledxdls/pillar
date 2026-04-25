/**
 * `pillar status` — single-pass project health summary.
 *
 * Composes existing core modules (map / history / env) plus a few
 * lightweight, offline filesystem checks (migration files on disk,
 * plugin count) to give one cohesive answer to "is this project
 * healthy?". Deliberately does NOT run `tsc` or any other expensive
 * check — that's `pillar doctor`'s job. `status` should return in well
 * under a second so it can be wired into shell prompts and CI.
 *
 * Each section reports one of three states:
 *
 *   ok   — nothing to do
 *   warn — informational drift the user can ignore (e.g. orphan files)
 *   fail — actionable problem (missing required env, invalid map)
 *
 * The overall report is `fail` if any section is `fail`, `warn` if any
 * is `warn`, otherwise `ok`. The CLI uses this to set the exit code.
 */

import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import { MapManager } from '../map/index.js';
import { HistoryManager } from '../history/index.js';
import { EnvManager } from '../env/index.js';

export interface FixReport {
  /** Section name this fix applies to (matches `StatusSection.name`). */
  section: string;
  /** Whether the fix actually changed anything. Idempotent fixes are common. */
  changed: boolean;
  /** Human-readable summary printed in TTY mode. */
  summary: string;
  /** Optional structured details (filenames, keys, etc). */
  details?: string[];
}

export type StatusLevel = 'ok' | 'warn' | 'fail';

export interface StatusSection {
  name: string;
  level: StatusLevel;
  /** One-line summary, always present. */
  summary: string;
  /** Optional structured details (rendered as a sub-list). */
  details?: string[];
}

export interface ProjectInfo {
  name: string;
  stack: string;
  language: string;
  architecture: string;
  database: string;
  orm: string;
  packageManager: string;
}

export interface StatusReport {
  project: ProjectInfo;
  sections: StatusSection[];
  /** Aggregate across sections — `fail` > `warn` > `ok`. */
  overall: StatusLevel;
}

export async function runStatus(
  projectRoot: string,
  config: PillarConfig,
): Promise<StatusReport> {
  const sections: StatusSection[] = [];
  sections.push(await sectionMap(projectRoot));
  sections.push(await sectionEnv(projectRoot));
  sections.push(await sectionMigrations(projectRoot, config));
  sections.push(await sectionHistory(projectRoot));
  sections.push(sectionPlugins(config));

  return {
    project: extractProject(config),
    sections,
    overall: aggregate(sections),
  };
}

function extractProject(config: PillarConfig): ProjectInfo {
  return {
    name: config.project.name,
    stack: config.project.stack,
    language: config.project.language,
    architecture: config.project.architecture,
    database: config.database.type,
    orm: config.database.orm,
    packageManager: config.project.packageManager,
  };
}

function aggregate(sections: StatusSection[]): StatusLevel {
  if (sections.some((s) => s.level === 'fail')) return 'fail';
  if (sections.some((s) => s.level === 'warn')) return 'warn';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Section: map
// ---------------------------------------------------------------------------

async function sectionMap(projectRoot: string): Promise<StatusSection> {
  const manager = new MapManager(projectRoot);
  const map = await manager.load();
  if (!map) {
    return {
      name: 'Map',
      level: 'fail',
      summary: 'No project map found',
      details: ['Run `pillar map refresh` to rebuild it.'],
    };
  }

  try {
    const result = await manager.validate();
    const unmapped = result.unmappedFiles.length;
    const stale = result.missingFiles.length;
    const total = unmapped + stale;

    if (total === 0) {
      return { name: 'Map', level: 'ok', summary: 'in sync' };
    }

    const details: string[] = [];
    if (unmapped > 0) details.push(`${unmapped} file(s) on disk not in the map`);
    if (stale > 0) details.push(`${stale} map entr${stale === 1 ? 'y' : 'ies'} referencing missing files`);
    return {
      name: 'Map',
      level: 'warn',
      summary: `${total} drift entr${total === 1 ? 'y' : 'ies'}`,
      details,
    };
  } catch {
    return { name: 'Map', level: 'warn', summary: 'validation failed (map unreadable)' };
  }
}

// ---------------------------------------------------------------------------
// Section: env
// ---------------------------------------------------------------------------

async function sectionEnv(projectRoot: string): Promise<StatusSection> {
  const examplePath = path.join(projectRoot, '.env.example');
  if (!(await fs.pathExists(examplePath))) {
    return { name: 'Env', level: 'ok', summary: 'no .env.example (skipped)' };
  }

  const manager = new EnvManager(projectRoot);
  try {
    const result = await manager.validate();
    if (result.valid) {
      return { name: 'Env', level: 'ok', summary: 'all keys present' };
    }
    const details: string[] = [];
    if (result.emptyRequired.length > 0) details.push(`required but empty: ${result.emptyRequired.join(', ')}`);
    if (result.missingInEnv.length > 0) details.push(`missing in .env: ${result.missingInEnv.join(', ')}`);
    if (result.extraInEnv.length > 0) details.push(`extra in .env: ${result.extraInEnv.join(', ')}`);

    // Empty required keys are a hard fail; missing-but-not-required is
    // a warn (the user may rely on shell env or CI secrets to provide).
    const level: StatusLevel = result.emptyRequired.length > 0 ? 'fail' : 'warn';
    return {
      name: 'Env',
      level,
      summary: level === 'fail'
        ? `${result.emptyRequired.length} required key(s) empty`
        : `${result.missingInEnv.length + result.extraInEnv.length} drift entr${result.missingInEnv.length + result.extraInEnv.length === 1 ? 'y' : 'ies'}`,
      details,
    };
  } catch (err) {
    return {
      name: 'Env',
      level: 'warn',
      summary: 'could not validate',
      details: [err instanceof Error ? err.message : String(err)],
    };
  }
}

// ---------------------------------------------------------------------------
// Section: migrations
// ---------------------------------------------------------------------------

async function sectionMigrations(
  projectRoot: string,
  config: PillarConfig,
): Promise<StatusSection> {
  const orm = config.database.orm;
  if (orm === 'none' || orm === 'mongoose') {
    return { name: 'Migrations', level: 'ok', summary: `${orm} (no migration tracking)` };
  }

  const dirs = migrationDirsFor(orm, projectRoot);
  for (const { dir, kind } of dirs) {
    if (!(await fs.pathExists(dir))) continue;
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) continue;
    const count = await countMigrations(dir, kind);
    if (count === 0) {
      return { name: 'Migrations', level: 'warn', summary: `${orm}: directory exists but contains 0 migrations` };
    }
    return {
      name: 'Migrations',
      level: 'ok',
      summary: `${count} ${orm} migration${count === 1 ? '' : 's'} on disk`,
      details: [path.relative(projectRoot, dir)],
    };
  }
  return {
    name: 'Migrations',
    level: 'warn',
    summary: `${orm}: no migrations directory found`,
    details: ['Run `pillar db generate --name <slug>` to create the first migration.'],
  };
}

interface MigrationDirCandidate {
  dir: string;
  /** `prisma` counts subdirs, others count files with these extensions. */
  kind: 'prisma-subdirs' | 'sql-files' | 'ts-or-js-files';
}

function migrationDirsFor(orm: string, projectRoot: string): MigrationDirCandidate[] {
  switch (orm) {
    case 'prisma':
      return [{ dir: path.join(projectRoot, 'prisma', 'migrations'), kind: 'prisma-subdirs' }];
    case 'drizzle':
      return [
        ...(process.env['PILLAR_DRIZZLE_OUT']
          ? [{ dir: process.env['PILLAR_DRIZZLE_OUT']!, kind: 'sql-files' as const }]
          : []),
        { dir: path.join(projectRoot, 'drizzle'), kind: 'sql-files' },
        { dir: path.join(projectRoot, 'src', 'drizzle'), kind: 'sql-files' },
      ];
    case 'typeorm':
      return [
        ...(process.env['PILLAR_TYPEORM_MIGRATIONS']
          ? [{ dir: process.env['PILLAR_TYPEORM_MIGRATIONS']!, kind: 'ts-or-js-files' as const }]
          : []),
        { dir: path.join(projectRoot, 'src', 'migrations'), kind: 'ts-or-js-files' },
      ];
    default:
      return [];
  }
}

async function countMigrations(
  dir: string,
  kind: MigrationDirCandidate['kind'],
): Promise<number> {
  const entries = await fs.readdir(dir);
  let n = 0;
  for (const name of entries) {
    const abs = path.join(dir, name);
    const stat = await fs.stat(abs);
    if (kind === 'prisma-subdirs') {
      if (stat.isDirectory() && /^\d{14}_/.test(name)) n++;
    } else if (kind === 'sql-files') {
      if (stat.isFile() && name.toLowerCase().endsWith('.sql')) n++;
    } else if (kind === 'ts-or-js-files') {
      if (stat.isFile() && /\.(ts|js)$/i.test(name)) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Section: history
// ---------------------------------------------------------------------------

async function sectionHistory(projectRoot: string): Promise<StatusSection> {
  const history = new HistoryManager(projectRoot);
  try {
    const recent = await history.recent(1);
    if (recent.length === 0) {
      return { name: 'History', level: 'ok', summary: 'no operations yet' };
    }
    const last = recent[0]!;
    const ago = humanAgo(new Date(last.timestamp).getTime());
    return {
      name: 'History',
      level: 'ok',
      summary: `last op ${ago}`,
      details: [`$ ${last.command}`],
    };
  } catch {
    return { name: 'History', level: 'ok', summary: 'no history' };
  }
}

function humanAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'in the future';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

// ---------------------------------------------------------------------------
// Section: plugins
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixers
// ---------------------------------------------------------------------------

/**
 * Apply known auto-fixes for sections that are warn-or-fail in the
 * given report. Each fixer is idempotent — running it on a healthy
 * project is a no-op that returns `changed: false`. The caller
 * (`pillar status --fix`) re-runs `runStatus` afterwards to produce
 * the post-fix report.
 *
 * Fixers are intentionally narrow: they only handle drift the tool
 * can resolve unambiguously. `Migrations` requires a user-supplied
 * name slug (no auto-fix); `History` and `Plugins` have nothing to
 * fix; `Map` calls `refresh`; `Env` calls `sync`.
 */
export async function runStatusFixes(
  projectRoot: string,
  config: PillarConfig,
  report: StatusReport,
): Promise<FixReport[]> {
  const fixes: FixReport[] = [];
  const needsFix = (name: string): boolean => {
    const section = report.sections.find((s) => s.name === name);
    return section !== undefined && section.level !== 'ok';
  };

  if (needsFix('Map')) fixes.push(await fixMap(projectRoot, config));
  if (needsFix('Env')) fixes.push(await fixEnv(projectRoot));

  return fixes;
}

async function fixMap(projectRoot: string, config: PillarConfig): Promise<FixReport> {
  const manager = new MapManager(projectRoot);
  try {
    // Capture pre-state so we can report a meaningful diff.
    const before = await manager.load();
    const beforeValidation = before ? await manager.validate() : null;
    const beforeDrift =
      (beforeValidation?.unmappedFiles.length ?? 0) +
      (beforeValidation?.missingFiles.length ?? 0);

    await manager.refresh(config);

    const afterValidation = await manager.validate();
    const afterDrift = afterValidation.unmappedFiles.length + afterValidation.missingFiles.length;

    if (!before) {
      return {
        section: 'Map',
        changed: true,
        summary: 'rebuilt missing project map',
      };
    }
    if (beforeDrift === 0 && afterDrift === 0) {
      return { section: 'Map', changed: false, summary: 'already in sync' };
    }
    return {
      section: 'Map',
      changed: true,
      summary: `refreshed (${beforeDrift} → ${afterDrift} drift entries)`,
    };
  } catch (err) {
    return {
      section: 'Map',
      changed: false,
      summary: `refresh failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function fixEnv(projectRoot: string): Promise<FixReport> {
  const manager = new EnvManager(projectRoot);
  try {
    const result = await manager.sync();
    if (result.added.length === 0) {
      return { section: 'Env', changed: false, summary: 'nothing to add' };
    }
    return {
      section: 'Env',
      changed: true,
      summary: `added ${result.added.length} key(s) to .env`,
      details: result.added,
    };
  } catch (err) {
    return {
      section: 'Env',
      changed: false,
      summary: `sync failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------

function sectionPlugins(config: PillarConfig): StatusSection {
  const count = config.plugins?.length ?? 0;
  if (count === 0) {
    return { name: 'Plugins', level: 'ok', summary: 'none configured' };
  }
  return {
    name: 'Plugins',
    level: 'ok',
    summary: `${count} configured`,
    details: config.plugins,
  };
}
