#!/usr/bin/env node
// Pillar — E2E smoke harness
//
// For every supported stack this script:
//   1. scaffolds a fresh project via `pillar init` (non-interactive flags),
//   2. installs the generated dependencies,
//   3. generates a sample `user` resource via `pillar add resource`,
//   4. runs `tsc --noEmit` (or `next build` for Next.js) to prove that the
//      emitted code type-checks end-to-end.
//
// Why this exists: stack-specific regressions (wrong imports, Fastify's
// in-function route scoping, Nest decorator metadata, etc.) have shipped
// before because unit tests pass in isolation but the generated code itself
// never gets compiled. This harness is the only gate that exercises the
// full pipeline the way a user hits it.
//
// Usage:
//   node scripts/e2e-smoke.mjs                    # run every stack
//   node scripts/e2e-smoke.mjs --only express,hono
//   node scripts/e2e-smoke.mjs --keep             # preserve temp dirs
//   node scripts/e2e-smoke.mjs --jobs 3           # parallel stacks
//
// Exit code is 0 iff every selected stack passes. Designed for CI:
// deterministic, bounded in wall time, and each stack's log is prefixed so
// interleaved output is still readable.

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const pillarBin = path.join(repoRoot, 'dist', 'bin', 'pillar.js');

const STACKS = /** @type {const} */ ([
  { name: 'express', category: 'api', typecheck: 'tsc' },
  { name: 'fastify', category: 'api', typecheck: 'tsc' },
  { name: 'hono', category: 'api', typecheck: 'tsc' },
  { name: 'nestjs', category: 'api', typecheck: 'tsc' },
  // Next.js uses its own bundler-aware tsconfig; `tsc --noEmit` is still the
  // right check because the generated tsconfig sets `noEmit: true`.
  { name: 'nextjs', category: 'fullstack', typecheck: 'tsc' },
]);

const args = parseArgs(process.argv.slice(2));
const selected = args.only
  ? STACKS.filter((s) => args.only.includes(s.name))
  : STACKS;

if (selected.length === 0) {
  console.error(`No stacks matched --only=${args.only?.join(',')}`);
  process.exit(2);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{only?: string[]; keep: boolean; jobs: number; installTimeoutMs: number; typecheckTimeoutMs: number}} */
  const out = { keep: false, jobs: 1, installTimeoutMs: 600_000, typecheckTimeoutMs: 300_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--only') out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a?.startsWith('--only=')) out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--jobs') out.jobs = Math.max(1, Number(argv[++i] ?? '1'));
    else if (a?.startsWith('--jobs=')) out.jobs = Math.max(1, Number(a.slice('--jobs='.length)));
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/e2e-smoke.mjs [--only express,fastify] [--keep] [--jobs N]');
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/**
 * @param {string} prefix
 * @param {string} cmd
 * @param {string[]} cmdArgs
 * @param {{cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number}} opts
 * @returns {Promise<{code: number; out: string}>}
 */
async function run(prefix, cmd, cmdArgs, opts) {
  const child = spawn(cmd, cmdArgs, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env, CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });

  let out = '';
  const onData = (chunk) => {
    const s = chunk.toString('utf-8');
    out += s;
    for (const line of s.split(/\r?\n/)) {
      if (line.length > 0) process.stdout.write(`[${prefix}] ${line}\n`);
    }
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);

  const timeout = opts.timeoutMs ?? 0;
  let timer;
  if (timeout > 0) {
    timer = setTimeout(() => {
      process.stdout.write(`[${prefix}] ⏱  Timed out after ${timeout}ms — killing\n`);
      child.kill('SIGKILL');
    }, timeout);
  }

  const [code] = await once(child, 'exit');
  if (timer) clearTimeout(timer);
  return { code: code ?? 1, out };
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function ensureBuilt() {
  if (!(await exists(pillarBin))) {
    console.log('→ Building pillar (dist/bin/pillar.js missing)…');
    const r = await run('build', 'npm', ['run', 'build'], { cwd: repoRoot, timeoutMs: 180_000 });
    if (r.code !== 0) {
      console.error('Build failed. Cannot run smoke tests.');
      process.exit(r.code);
    }
  }
}

/**
 * @param {typeof STACKS[number]} stack
 * @returns {Promise<{stack: string; ok: boolean; reason?: string; durationMs: number}>}
 */
async function runStack(stack) {
  const started = Date.now();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), `pillar-e2e-${stack.name}-`));
  const projectName = `app-${stack.name}`;
  const projectDir = path.join(tmpBase, projectName);
  const prefix = stack.name.padEnd(7);
  let failure = null;

  try {
    // 1. pillar init — non-interactive, skip install so we can install once
    //    below with our own timeout and error reporting.
    const initArgs = [
      pillarBin, 'init', projectName,
      '--yes',
      '--stack', stack.name,
      '--category', stack.category,
      '--language', 'typescript',
      '--database', 'none',
      '--orm', 'none',
      '--architecture', 'feature-first',
      '--package-manager', 'npm',
      '--test-framework', 'vitest',
      '--skip-install',
      '--skip-git',
    ];
    const initRes = await run(prefix, process.execPath, initArgs, {
      cwd: tmpBase,
      timeoutMs: 60_000,
    });
    if (initRes.code !== 0) {
      failure = `pillar init failed (exit ${initRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, durationMs: Date.now() - started };
    }

    // 2. npm install inside the scaffolded project.
    const installRes = await run(prefix, 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: projectDir,
      timeoutMs: args.installTimeoutMs,
    });
    if (installRes.code !== 0) {
      failure = `npm install failed (exit ${installRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, durationMs: Date.now() - started };
    }

    // 3. pillar add resource — the core codegen path we want to validate.
    const addRes = await run(prefix, process.execPath, [
      pillarBin, 'add', 'resource', 'user',
      '--fields', 'name:string email:string',
    ], { cwd: projectDir, timeoutMs: 60_000 });
    if (addRes.code !== 0) {
      failure = `pillar add resource failed (exit ${addRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, durationMs: Date.now() - started };
    }

    // 4. Type-check the generated project. This is the actual regression
    //    gate: every stack-specific scaffolding bug surfaces here.
    const tscBin = path.join(projectDir, 'node_modules', '.bin', 'tsc');
    if (!(await exists(tscBin))) {
      failure = 'tsc not installed — did deps resolve?';
      return { stack: stack.name, ok: false, reason: failure, durationMs: Date.now() - started };
    }
    const tscRes = await run(prefix, tscBin, ['--noEmit', '--pretty', 'false'], {
      cwd: projectDir,
      timeoutMs: args.typecheckTimeoutMs,
    });
    if (tscRes.code !== 0) {
      failure = `tsc --noEmit reported errors (exit ${tscRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, durationMs: Date.now() - started };
    }

    return { stack: stack.name, ok: true, durationMs: Date.now() - started };
  } finally {
    // Preserve the project dir on failure (when --keep) so a human can
    // reproduce. Always clean up on success to avoid filling /tmp.
    if (!(args.keep && failure)) {
      await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    } else {
      process.stdout.write(`[${prefix}] 📁 Preserved: ${projectDir}\n`);
    }
  }
}

/**
 * Run at most `args.jobs` stacks concurrently.
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<{stack: string; ok: boolean; reason?: string; durationMs: number}>} worker
 */
async function pool(items, concurrency, worker) {
  const results = [];
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

async function main() {
  await ensureBuilt();

  console.log(`\n▶ Pillar E2E smoke — ${selected.length} stack(s), ${args.jobs} job(s)\n`);

  const results = await pool(selected, args.jobs, runStack);

  // Summary table.
  console.log('\n──────────── Summary ────────────');
  for (const r of results) {
    const mark = r.ok ? '✔' : '✘';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const line = `  ${mark} ${r.stack.padEnd(8)} ${dur.padStart(7)}`;
    console.log(r.ok ? line : `${line}  — ${r.reason}`);
  }
  console.log('');

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`✘ ${failed.length}/${results.length} stack(s) failed.`);
    process.exit(1);
  }
  console.log(`✔ All ${results.length} stack(s) passed.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
