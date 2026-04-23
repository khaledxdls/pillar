#!/usr/bin/env node
// Pillar — AI feature live E2E harness
//
// For every supported stack this script:
//   1. scaffolds a fresh project via `pillar init`,
//   2. installs the generated dependencies,
//   3. runs THREE `pillar ai` prompts that exercise the full feature surface:
//        a) custom-content path  — "add a /health endpoint"
//        b) resource-skeleton path — "add a products resource with fields"
//        c) two-pass modify path — "add a search method to the products controller"
//   4. type-checks the project with `tsc --noEmit` after EACH prompt so we
//      know which prompt (if any) produced code that doesn't compile,
//   5. captures the token totals and warnings from each `pillar ai` run.
//
// Why three prompts: the AI feature has three internally-distinct code
// paths (custom `content`, skeleton-engine kinds, two-pass modify). One
// prompt won't catch a regression in the other two. Five stacks × three
// prompts is the minimum coverage that proves the live feature works
// against a real provider.
//
// Provider: OpenAI by default (env: OPENAI_API_KEY). Override model with
// `--model gpt-4o` if you want to spend more for tighter output. Default
// `gpt-4o-mini` keeps the whole sweep under a few cents.
//
// Usage:
//   OPENAI_API_KEY=sk-… node scripts/ai-e2e.mjs
//   OPENAI_API_KEY=sk-… node scripts/ai-e2e.mjs --only express,hono
//   OPENAI_API_KEY=sk-… node scripts/ai-e2e.mjs --jobs 2 --model gpt-4o
//   OPENAI_API_KEY=sk-… node scripts/ai-e2e.mjs --keep    # preserve dirs

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
  { name: 'express', category: 'api' },
  { name: 'fastify', category: 'api' },
  { name: 'hono', category: 'api' },
  { name: 'nestjs', category: 'api' },
  { name: 'nextjs', category: 'fullstack' },
]);

/**
 * The three prompts. Order matters — prompt C depends on prompt B's output
 * existing on disk (the products controller). If you add prompts here,
 * keep them ordered by dependency.
 *
 *   path: identifies which internal AI code path is being exercised, so the
 *         summary table can attribute failures.
 *   text: the natural-language request sent to the model.
 *   expectFiles: a non-empty subset of files that MUST appear after the
 *         prompt — guards against the model returning an empty plan.
 */
/**
 * Three prompts cover the three intended AI code paths:
 *   custom — a new file with custom `content` (NOT CRUD; AI is supposed to
 *            defer CRUD to `pillar add resource`).
 *   defer  — a CRUD-shaped request that SHOULD be deferred to the CLI.
 *            We assert the model returns an empty plan with a "Run:" hint
 *            in the summary instead of generating files.
 *   modify — two-pass modification of an existing controller. The harness
 *            scaffolds a `products` resource via `pillar add resource`
 *            BEFORE this prompt so the target file is guaranteed to exist
 *            and to be coherent.
 */
const PROMPTS = [
  {
    id: 'custom',
    path: 'content (custom file)',
    text: 'Create a NEW file for a health check. The new file should export a route/handler for GET /health that returns { status: "ok", uptime: <seconds since process start> } as JSON. Then modify the application entry file (app.ts / main.ts / server.ts) to import and register the new route. Do not inline the handler into the entry file.',
    expectAtLeastOneOf: [
      'src/health.ts', 'src/features/health/health.ts',
      'src/health.routes.ts', 'src/features/health/health.routes.ts',
      'src/features/health/health.controller.ts', // nestjs
      'src/features/health/health.module.ts',     // nestjs
      'app/health/route.ts', 'src/app/health/route.ts', // nextjs
    ],
  },
  {
    id: 'defer',
    path: 'defer-to-CLI (boilerplate)',
    text: 'Add a products resource with these fields: name (string), price (number), stock (number). Generate the standard CRUD scaffold.',
    expectEmptyPlan: true,
    expectSummaryContains: 'pillar add resource',
  },
  {
    id: 'modify',
    path: 'two-pass modify',
    setup: { command: ['add', 'resource', 'products', '--fields', 'name:string price:number stock:number'] },
    text: 'Add a search capability to the products feature: support a query-string parameter `q` that filters products whose name contains it. Modify the existing products files (controller, routes, or route handler — whichever this stack uses). Do NOT create new resource files; do NOT scaffold a separate search resource.',
    requiresModification: true,
  },
];

const args = parseArgs(process.argv.slice(2));
const selected = args.only ? STACKS.filter((s) => args.only.includes(s.name)) : STACKS;

if (selected.length === 0) {
  console.error(`No stacks matched --only=${args.only?.join(',')}`);
  process.exit(2);
}
if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error('Set OPENAI_API_KEY or ANTHROPIC_API_KEY before running.');
  process.exit(2);
}

const PROVIDER = process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
const MODEL = args.model ?? (PROVIDER === 'anthropic' ? 'claude-sonnet-4-6' : 'gpt-4o-mini');

function parseArgs(argv) {
  const out = { keep: false, jobs: 1, model: undefined, installTimeoutMs: 600_000, typecheckTimeoutMs: 300_000, aiTimeoutMs: 180_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') out.keep = true;
    else if (a === '--only') out.only = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a?.startsWith('--only=')) out.only = a.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--jobs') out.jobs = Math.max(1, Number(argv[++i] ?? '1'));
    else if (a?.startsWith('--jobs=')) out.jobs = Math.max(1, Number(a.slice('--jobs='.length)));
    else if (a === '--model') out.model = argv[++i];
    else if (a?.startsWith('--model=')) out.model = a.slice('--model='.length);
    else if (a === '-h' || a === '--help') {
      console.log('Usage: OPENAI_API_KEY=… node scripts/ai-e2e.mjs [--only express,hono] [--keep] [--jobs N] [--model gpt-4o]');
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

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
    if (!opts.quiet) {
      for (const line of s.split(/\r?\n/)) {
        if (line.length > 0) process.stdout.write(`[${prefix}] ${line}\n`);
      }
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
      console.error('Build failed. Cannot run AI E2E.');
      process.exit(r.code);
    }
  }
}

/**
 * Extract `Provider usage: <N> tokens across <P> pass(es)` from the AI
 * command output. Falls back to nulls when the line is absent (e.g. when
 * the provider didn't report usage). Returns warnings count too.
 */
function parseAiOutput(out) {
  const tokenMatch = out.match(/Provider usage: (\d+) tokens across (\d+) pass/);
  const warnMatch = out.match(/Warnings:/);
  const truncMatch = out.match(/Skipped reading (\d+) file\(s\) in pass 2/);
  const summaryMatch = out.match(/AI Generation Plan[\s\S]*?\n\s+(.+?)\n/);
  return {
    tokens: tokenMatch ? Number(tokenMatch[1]) : null,
    passes: tokenMatch ? Number(tokenMatch[2]) : null,
    hasWarnings: !!warnMatch,
    truncatedFiles: truncMatch ? Number(truncMatch[1]) : 0,
    summary: summaryMatch ? summaryMatch[1].trim() : null,
  };
}

/**
 * Check if at least one of `candidates` exists under `projectDir`. Used to
 * verify that a creation prompt actually produced something visible on
 * disk — a model could return an empty plan and our schema would accept
 * it; this catches that.
 */
async function anyExists(projectDir, candidates) {
  for (const c of candidates) {
    if (await exists(path.join(projectDir, c))) return c;
  }
  return null;
}

async function runStack(stack) {
  const started = Date.now();
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), `pillar-ai-e2e-${stack.name}-`));
  const projectName = `app-${stack.name}`;
  const projectDir = path.join(tmpBase, projectName);
  const prefix = stack.name.padEnd(7);
  const promptResults = [];
  let failure = null;

  try {
    // 1. Scaffold + install. Same boilerplate as the smoke harness.
    const initRes = await run(prefix, process.execPath, [
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
      '--skip-install', '--skip-git',
    ], { cwd: tmpBase, timeoutMs: 60_000 });
    if (initRes.code !== 0) {
      failure = `pillar init failed (exit ${initRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, prompts: promptResults, durationMs: Date.now() - started };
    }

    const installRes = await run(prefix, 'npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: projectDir, timeoutMs: args.installTimeoutMs,
    });
    if (installRes.code !== 0) {
      failure = `npm install failed (exit ${installRes.code})`;
      return { stack: stack.name, ok: false, reason: failure, prompts: promptResults, durationMs: Date.now() - started };
    }

    // 2. Run each prompt sequentially. After each: tsc --noEmit. We attribute
    //    a tsc failure to whichever prompt was just executed.
    const tscBin = path.join(projectDir, 'node_modules', '.bin', 'tsc');
    if (!(await exists(tscBin))) {
      failure = 'tsc not installed — did deps resolve?';
      return { stack: stack.name, ok: false, reason: failure, prompts: promptResults, durationMs: Date.now() - started };
    }

    for (const prompt of PROMPTS) {
      // Optional setup step (e.g. scaffold a resource the AI prompt will modify).
      if (prompt.setup) {
        const setupRes = await run(prefix, process.execPath, [pillarBin, ...prompt.setup.command], {
          cwd: projectDir, timeoutMs: 60_000,
        });
        if (setupRes.code !== 0) {
          failure = `prompt "${prompt.id}" — setup ${prompt.setup.command.join(' ')} failed (exit ${setupRes.code})`;
          break;
        }
      }

      const before = await snapshotFileTimes(projectDir);

      const aiRes = await run(prefix, process.execPath, [
        pillarBin, 'ai', prompt.text,
        '--provider', PROVIDER,
        '--model', MODEL,
        '--yes',
      ], { cwd: projectDir, timeoutMs: args.aiTimeoutMs });

      const parsed = parseAiOutput(aiRes.out);
      const promptResult = {
        id: prompt.id,
        path: prompt.path,
        ok: aiRes.code === 0,
        ...parsed,
        tscOk: null,
        reason: null,
      };

      if (aiRes.code !== 0) {
        promptResult.reason = `pillar ai exited ${aiRes.code}`;
        promptResults.push(promptResult);
        failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
        break;
      }

      // Defer-to-CLI prompts must produce no files and a "Run: pillar ..." hint.
      if (prompt.expectEmptyPlan) {
        const after = await snapshotFileTimes(projectDir);
        const changed = diffSnapshots(before, after);
        if (changed.length > 0) {
          promptResult.reason = `expected empty plan, but ${changed.length} file(s) changed`;
          promptResults.push(promptResult);
          failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
          break;
        }
        if (prompt.expectSummaryContains && !aiRes.out.includes(prompt.expectSummaryContains)) {
          promptResult.reason = `summary did not mention "${prompt.expectSummaryContains}" (model regenerated boilerplate instead of deferring)`;
          promptResults.push(promptResult);
          failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
          break;
        }
        promptResult.evidence = 'deferred to CLI';
        promptResult.tscOk = true; // no code emitted; nothing to type-check
        promptResults.push(promptResult);
        continue;
      }

      // Existence guard for creation prompts.
      if (prompt.expectAtLeastOneOf && prompt.expectAtLeastOneOf.length > 0) {
        const found = await anyExists(projectDir, prompt.expectAtLeastOneOf);
        if (!found) {
          promptResult.reason = `none of expected files were created: ${prompt.expectAtLeastOneOf.join(', ')}`;
          promptResults.push(promptResult);
          failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
          break;
        }
        promptResult.evidence = found;
      }

      // For modify prompts, verify *something* on disk changed.
      if (prompt.requiresModification) {
        const after = await snapshotFileTimes(projectDir);
        const changed = diffSnapshots(before, after);
        if (changed.length === 0) {
          promptResult.reason = 'no files were modified';
          promptResults.push(promptResult);
          failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
          break;
        }
        promptResult.evidence = changed.slice(0, 3).join(', ');
      }

      // Type-check after this prompt.
      const tscRes = await run(prefix, tscBin, ['--noEmit', '--pretty', 'false'], {
        cwd: projectDir,
        timeoutMs: args.typecheckTimeoutMs,
        quiet: true, // tsc output is loud; only print on failure
      });
      promptResult.tscOk = tscRes.code === 0;
      if (!promptResult.tscOk) {
        // Surface tsc errors so the human reading the log can see what broke.
        const errLines = tscRes.out.split('\n').filter((l) => l.includes('error TS')).slice(0, 8);
        for (const l of errLines) process.stdout.write(`[${prefix}]   tsc: ${l}\n`);
        promptResult.reason = `tsc --noEmit failed after this prompt`;
        promptResults.push(promptResult);
        failure = `prompt "${prompt.id}" — ${promptResult.reason}`;
        break;
      }

      promptResults.push(promptResult);
    }

    if (failure) {
      return { stack: stack.name, ok: false, reason: failure, prompts: promptResults, durationMs: Date.now() - started };
    }
    return { stack: stack.name, ok: true, prompts: promptResults, durationMs: Date.now() - started };
  } finally {
    if (!(args.keep && failure)) {
      await fs.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
    } else {
      process.stdout.write(`[${prefix}] 📁 Preserved: ${projectDir}\n`);
    }
  }
}

/**
 * Walk every file under `dir` (excluding node_modules / .pillar) and
 * collect `mtimeMs`. Used to detect whether a modify-prompt actually
 * changed anything. We compare snapshots rather than diffing content
 * because the latter is expensive and sensitive to whitespace noise.
 */
async function snapshotFileTimes(dir) {
  const out = new Map();
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === '.pillar' || ent.name === '.git' || ent.name === 'dist') continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile()) {
        const st = await fs.stat(full);
        out.set(path.relative(dir, full), st.mtimeMs);
      }
    }
  }
  await walk(dir);
  return out;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [p, t] of after) {
    const prev = before.get(p);
    if (prev === undefined || prev !== t) changed.push(p);
  }
  return changed;
}

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

  console.log(`\n▶ Pillar AI E2E — ${selected.length} stack(s) × ${PROMPTS.length} prompt(s) | ${PROVIDER}/${MODEL} | ${args.jobs} job(s)\n`);

  const results = await pool(selected, args.jobs, runStack);

  // Per-stack prompt grid.
  console.log('\n──────────── Per-prompt detail ────────────');
  let totalTokens = 0;
  for (const r of results) {
    console.log(`\n  ${r.stack}  (${(r.durationMs / 1000).toFixed(1)}s)  — ${r.ok ? '✔ all prompts passed' : '✘ ' + r.reason}`);
    for (const p of r.prompts ?? []) {
      const tok = p.tokens ?? '?';
      const passes = p.passes ?? '?';
      const ai = p.ok ? '✔' : '✘';
      const tsc = p.tscOk === null ? '·' : p.tscOk ? '✔' : '✘';
      const evidence = p.evidence ? `  [${p.evidence}]` : '';
      const reason = p.reason ? `  — ${p.reason}` : '';
      const trunc = p.truncatedFiles > 0 ? `  ⚠ ${p.truncatedFiles} truncated` : '';
      console.log(`    ${ai} ai / ${tsc} tsc   ${p.id.padEnd(8)} ${String(tok).padStart(6)} tok / ${passes} pass${trunc}${evidence}${reason}`);
      if (typeof p.tokens === 'number') totalTokens += p.tokens;
    }
  }

  console.log(`\n──────────── Summary ────────────`);
  for (const r of results) {
    const mark = r.ok ? '✔' : '✘';
    const dur = `${(r.durationMs / 1000).toFixed(1)}s`;
    const promptsOk = (r.prompts ?? []).filter((p) => p.ok && p.tscOk).length;
    const total = PROMPTS.length;
    const line = `  ${mark} ${r.stack.padEnd(8)} ${dur.padStart(7)}   ${promptsOk}/${total} prompts`;
    console.log(r.ok ? line : `${line}  — ${r.reason}`);
  }
  console.log(`\n  Total billed tokens (sum across all prompts): ${totalTokens}`);
  console.log('');

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`✘ ${failed.length}/${results.length} stack(s) failed.`);
    process.exit(1);
  }
  console.log(`✔ All ${results.length} stack(s) passed all ${PROMPTS.length} prompts.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
