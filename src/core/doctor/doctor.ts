import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import { MapManager } from '../map/index.js';
import { CONFIG_FILE } from '../../utils/constants.js';
import { pillarConfigSchema } from '../config/schema.js';

export interface DiagnosticCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  details?: string[];
  fixable?: boolean;
}

export interface DiagnosticReport {
  checks: DiagnosticCheck[];
  score: number;
}

export interface FixResult {
  name: string;
  fixed: boolean;
  message: string;
}

export async function runDiagnostics(projectRoot: string): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];

  checks.push(await checkConfig(projectRoot));
  checks.push(await checkDependencies(projectRoot));
  checks.push(await checkProjectStructure(projectRoot));
  checks.push(...(await checkMap(projectRoot)));
  checks.push(await checkEnv(projectRoot));
  checks.push(await checkGitIgnore(projectRoot));

  const score = calculateScore(checks);

  return { checks, score };
}

async function checkConfig(projectRoot: string): Promise<DiagnosticCheck> {
  const configPath = path.join(projectRoot, CONFIG_FILE);

  if (!(await fs.pathExists(configPath))) {
    return {
      name: 'Configuration',
      status: 'fail',
      message: 'pillar.config.json not found',
    };
  }

  try {
    const raw = await fs.readJson(configPath);
    const result = pillarConfigSchema.safeParse(raw);
    if (!result.success) {
      return {
        name: 'Configuration',
        status: 'fail',
        message: 'pillar.config.json has validation errors',
        details: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      };
    }
    return { name: 'Configuration', status: 'pass', message: 'pillar.config.json is valid' };
  } catch {
    return { name: 'Configuration', status: 'fail', message: 'pillar.config.json is not valid JSON' };
  }
}

async function checkDependencies(projectRoot: string): Promise<DiagnosticCheck> {
  const nodeModules = path.join(projectRoot, 'node_modules');
  const packageJson = path.join(projectRoot, 'package.json');

  if (!(await fs.pathExists(packageJson))) {
    return { name: 'Dependencies', status: 'fail', message: 'package.json not found' };
  }

  if (!(await fs.pathExists(nodeModules))) {
    return {
      name: 'Dependencies',
      status: 'fail',
      message: 'node_modules not found — run your package manager install command',
    };
  }

  // Check for missing dependencies
  try {
    const pkg = await fs.readJson(packageJson);
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    const missing: string[] = [];

    for (const dep of Object.keys(allDeps)) {
      const depPath = path.join(nodeModules, dep);
      if (!(await fs.pathExists(depPath))) {
        missing.push(dep);
      }
    }

    if (missing.length > 0) {
      return {
        name: 'Dependencies',
        status: 'warn',
        message: `${missing.length} missing package(s)`,
        details: missing,
      };
    }

    return { name: 'Dependencies', status: 'pass', message: 'All dependencies installed' };
  } catch {
    return { name: 'Dependencies', status: 'warn', message: 'Could not verify dependencies' };
  }
}

async function checkProjectStructure(projectRoot: string): Promise<DiagnosticCheck> {
  const srcDir = path.join(projectRoot, 'src');

  if (!(await fs.pathExists(srcDir))) {
    return { name: 'Project structure', status: 'fail', message: 'src/ directory not found' };
  }

  return { name: 'Project structure', status: 'pass', message: 'src/ directory exists' };
}

async function checkMap(projectRoot: string): Promise<DiagnosticCheck[]> {
  const checks: DiagnosticCheck[] = [];
  const mapManager = new MapManager(projectRoot);
  const map = await mapManager.load();

  if (!map) {
    checks.push({
      name: 'Project map',
      status: 'warn',
      message: 'No project map found — run "pillar map --refresh" to generate one',
    });
    return checks;
  }

  const validation = await mapManager.validate();

  if (validation.unmappedFiles.length > 0) {
    checks.push({
      name: 'Unmapped files',
      status: 'warn',
      message: `${validation.unmappedFiles.length} file(s) not registered in the project map`,
      details: validation.unmappedFiles.slice(0, 10),
      fixable: true,
    });
  } else {
    checks.push({
      name: 'Unmapped files',
      status: 'pass',
      message: 'All files are registered in the project map',
    });
  }

  if (validation.missingFiles.length > 0) {
    checks.push({
      name: 'Missing files',
      status: 'warn',
      message: `${validation.missingFiles.length} map entry/entries point to missing file(s)`,
      details: validation.missingFiles.slice(0, 10),
      fixable: true,
    });
  } else {
    checks.push({
      name: 'Missing files',
      status: 'pass',
      message: 'All map entries point to existing files',
    });
  }

  return checks;
}

async function checkEnv(projectRoot: string): Promise<DiagnosticCheck> {
  const envExample = path.join(projectRoot, '.env.example');
  const envFile = path.join(projectRoot, '.env');

  if (!(await fs.pathExists(envExample))) {
    return { name: 'Environment', status: 'warn', message: '.env.example not found' };
  }

  if (!(await fs.pathExists(envFile))) {
    return { name: 'Environment', status: 'warn', message: '.env not found — copy from .env.example' };
  }

  // Check that all keys from .env.example exist in .env
  const exampleContent = await fs.readFile(envExample, 'utf-8');
  const envContent = await fs.readFile(envFile, 'utf-8');

  const exampleKeys = extractEnvKeys(exampleContent);
  const envKeys = new Set(extractEnvKeys(envContent));
  const missing = exampleKeys.filter((k) => !envKeys.has(k));

  if (missing.length > 0) {
    return {
      name: 'Environment',
      status: 'warn',
      message: `${missing.length} key(s) from .env.example missing in .env`,
      details: missing,
      fixable: true,
    };
  }

  return { name: 'Environment', status: 'pass', message: 'Environment variables match .env.example' };
}

async function checkGitIgnore(projectRoot: string): Promise<DiagnosticCheck> {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  if (!(await fs.pathExists(gitignorePath))) {
    return { name: '.gitignore', status: 'warn', message: '.gitignore not found' };
  }

  const content = await fs.readFile(gitignorePath, 'utf-8');
  const critical = ['node_modules', '.env', 'dist'];
  const missing = critical.filter((entry) => !content.includes(entry));

  if (missing.length > 0) {
    return {
      name: '.gitignore',
      status: 'warn',
      message: `Missing critical entries in .gitignore`,
      details: missing,
      fixable: true,
    };
  }

  return { name: '.gitignore', status: 'pass', message: '.gitignore looks good' };
}

function extractEnvKeys(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'))
    .map((line) => line.split('=')[0]!.trim())
    .filter(Boolean);
}

/**
 * Attempt to auto-fix all fixable issues found by diagnostics.
 * Each fixer is isolated — one failure does not block others.
 */
export async function runFixes(projectRoot: string, report: DiagnosticReport): Promise<FixResult[]> {
  const results: FixResult[] = [];
  const fixableChecks = report.checks.filter((c) => c.fixable && c.status !== 'pass');

  if (fixableChecks.length === 0) {
    return results;
  }

  const configPath = path.join(projectRoot, CONFIG_FILE);
  let config: PillarConfig | null = null;
  if (await fs.pathExists(configPath)) {
    try {
      const raw = await fs.readJson(configPath);
      const parsed = pillarConfigSchema.safeParse(raw);
      if (parsed.success) config = parsed.data;
    } catch { /* config unavailable — skip config-dependent fixes */ }
  }

  for (const check of fixableChecks) {
    try {
      switch (check.name) {
        case 'Missing files':
          results.push(await fixMissingFiles(projectRoot, config));
          break;
        case 'Unmapped files':
          results.push(await fixUnmappedFiles(projectRoot, config));
          break;
        case '.gitignore':
          results.push(await fixGitIgnore(projectRoot, check.details ?? []));
          break;
        case 'Environment':
          results.push(await fixEnv(projectRoot));
          break;
      }
    } catch (error) {
      results.push({
        name: check.name,
        fixed: false,
        message: `Failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }

  return results;
}

/**
 * Remove stale map entries that reference files no longer on disk.
 */
async function fixMissingFiles(projectRoot: string, config: PillarConfig | null): Promise<FixResult> {
  if (!config) {
    return { name: 'Missing files', fixed: false, message: 'Cannot fix — config unavailable' };
  }

  const mapManager = new MapManager(projectRoot);
  const validation = await mapManager.validate();

  if (validation.missingFiles.length === 0) {
    return { name: 'Missing files', fixed: true, message: 'No stale entries found' };
  }

  // Refresh rebuilds from filesystem, preserving purposes of files that still exist
  await mapManager.refresh(config);

  return {
    name: 'Missing files',
    fixed: true,
    message: `Removed ${validation.missingFiles.length} stale map entry/entries`,
  };
}

/**
 * Register unmapped src/ files into the project map.
 */
async function fixUnmappedFiles(projectRoot: string, config: PillarConfig | null): Promise<FixResult> {
  if (!config) {
    return { name: 'Unmapped files', fixed: false, message: 'Cannot fix — config unavailable' };
  }

  const mapManager = new MapManager(projectRoot);
  const validation = await mapManager.validate();

  if (validation.unmappedFiles.length === 0) {
    return { name: 'Unmapped files', fixed: true, message: 'No unmapped files found' };
  }

  for (const file of validation.unmappedFiles) {
    // Only register files, not directories (directories end with /)
    if (!file.endsWith('/')) {
      await mapManager.registerEntry(file, '');
    }
  }

  return {
    name: 'Unmapped files',
    fixed: true,
    message: `Registered ${validation.unmappedFiles.filter((f) => !f.endsWith('/')).length} file(s) in the map`,
  };
}

/**
 * Append missing critical entries to .gitignore.
 */
async function fixGitIgnore(projectRoot: string, missingEntries: string[]): Promise<FixResult> {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  let content = '';
  if (await fs.pathExists(gitignorePath)) {
    content = await fs.readFile(gitignorePath, 'utf-8');
  }

  const toAdd = missingEntries.filter((entry) => !content.includes(entry));
  if (toAdd.length === 0) {
    return { name: '.gitignore', fixed: true, message: 'No missing entries' };
  }

  const suffix = (content.endsWith('\n') || content === '') ? '' : '\n';
  const additions = toAdd.map((e) => e.includes('/') ? e : `${e}/`).join('\n');
  await fs.writeFile(gitignorePath, content + suffix + additions + '\n', 'utf-8');

  return {
    name: '.gitignore',
    fixed: true,
    message: `Added ${toAdd.length} entry/entries: ${toAdd.join(', ')}`,
  };
}

/**
 * Copy missing keys from .env.example to .env with empty values.
 */
async function fixEnv(projectRoot: string): Promise<FixResult> {
  const envExample = path.join(projectRoot, '.env.example');
  const envFile = path.join(projectRoot, '.env');

  if (!(await fs.pathExists(envExample))) {
    return { name: 'Environment', fixed: false, message: '.env.example does not exist' };
  }

  const exampleContent = await fs.readFile(envExample, 'utf-8');
  let envContent = (await fs.pathExists(envFile))
    ? await fs.readFile(envFile, 'utf-8')
    : '';

  const exampleKeys = extractEnvKeys(exampleContent);
  const envKeys = new Set(extractEnvKeys(envContent));
  const missing = exampleKeys.filter((k) => !envKeys.has(k));

  if (missing.length === 0) {
    return { name: 'Environment', fixed: true, message: 'No missing keys' };
  }

  const suffix = (envContent.endsWith('\n') || envContent === '') ? '' : '\n';
  const additions = missing.map((k) => `${k}=`).join('\n');
  await fs.writeFile(envFile, envContent + suffix + additions + '\n', 'utf-8');

  return {
    name: 'Environment',
    fixed: true,
    message: `Added ${missing.length} key(s) to .env: ${missing.join(', ')}`,
  };
}

function calculateScore(checks: DiagnosticCheck[]): number {
  if (checks.length === 0) return 0;

  const weights = { pass: 100, warn: 50, fail: 0 };
  const total = checks.reduce((sum, check) => sum + weights[check.status], 0);
  return Math.round(total / checks.length);
}
