import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import {
  buildContext,
  buildPrompt,
  callAIWithFileContext,
  executePlan,
  previewPlan,
  getSystemPrompt,
  AIResponseParseError,
  DEFAULT_MODELS,
  type AIProviderConfig,
} from '../core/ai/index.js';
import type { ExecutionWarning } from '../core/ai/plan-executor.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface AIOptions {
  provider?: string;
  model?: string;
  dryRun?: boolean;
  yes?: boolean;
  printPlan?: boolean;
  retry?: boolean;
}

const LAST_RUN_PATH = '.pillar/ai-last.json';
const MAX_ERROR_BYTES = 8 * 1024;
const MAX_ERROR_LINES = 60;

interface LastRunSnapshot {
  request: string;
  provider: 'openai' | 'anthropic';
  model: string;
  summary: string;
  createdFiles: string[];
  modifiedFiles: string[];
  timestamp: string;
}

export async function aiCommand(request: string | undefined, options: AIOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const mapManager = new MapManager(projectRoot);
  const map = await mapManager.load();

  // Retry path: replay the last request augmented with typecheck errors.
  // Request arg is optional when --retry is used; the saved snapshot carries it.
  let effectiveRequest: string;
  let retryContext: string | null = null;
  if (options.retry) {
    const snapshot = await loadLastRun(projectRoot);
    if (!snapshot) {
      logger.error('No previous `pillar ai` run to retry.', `Expected snapshot at ${LAST_RUN_PATH}.`);
      process.exitCode = 1;
      return;
    }
    logger.info(`Retrying: ${chalk.dim(snapshot.request)}`);
    logger.info(`Previous run: ${snapshot.provider}/${snapshot.model} at ${snapshot.timestamp}`);

    const errors = await withSpinner('Running tsc --noEmit to collect errors', async () =>
      collectTypecheckErrors(projectRoot),
    );

    if (errors.kind === 'no-tsconfig') {
      logger.info('No tsconfig.json — retry needs a TypeScript project to collect errors.');
      process.exitCode = 1;
      return;
    }
    if (errors.kind === 'clean') {
      logger.success('tsc reports no errors — nothing to retry against.');
      return;
    }

    logger.info(`Captured ${errors.lineCount} tsc error line(s) (${errors.bytes} bytes) to feed back to the model.`);
    retryContext = errors.text;
    effectiveRequest = snapshot.request;
  } else {
    if (!request || request.trim().length === 0) {
      logger.error('Missing request.', 'Usage: pillar ai "<what to generate>" — or pass --retry to replay the last run.');
      process.exitCode = 1;
      return;
    }
    effectiveRequest = request;
  }

  const providerConfig = resolveProvider(options);
  if (!providerConfig) {
    logger.error('No AI provider configured.');
    logger.blank();
    logger.info('Set one of these environment variables:');
    logger.list([
      'OPENAI_API_KEY    — for OpenAI (GPT-4, etc.)',
      'ANTHROPIC_API_KEY — for Anthropic (Claude, etc.)',
    ]);
    logger.blank();
    logger.info('Then run:');
    logger.list([
      `pillar ai "${effectiveRequest}"`,
      `pillar ai "${effectiveRequest}" --provider openai --model gpt-4o`,
      `pillar ai "${effectiveRequest}" --provider anthropic --model claude-sonnet-4-6`,
    ]);
    process.exitCode = 1;
    return;
  }

  const context = buildContext(config, map);
  // On retry, append the tsc errors to the user request so they land in
  // pass-1 (plan) and flow naturally into pass-2 (file-enriched). The
  // model sees the original intent AND the concrete failures it needs
  // to fix — no prose prefix needed since buildPrompt() already frames it.
  const augmentedRequest = retryContext
    ? [
        effectiveRequest,
        '',
        'The previous plan for this request was applied, but `tsc --noEmit` now reports these errors. Emit a NEW plan that modifies the failing files to fix them. Do NOT recreate files that already exist — use modify actions. Match identifiers exactly as they appear in the files.',
        '',
        '--- tsc --noEmit ---',
        retryContext,
      ].join('\n')
    : effectiveRequest;
  const userPrompt = buildPrompt(context, augmentedRequest);
  const systemPrompt = getSystemPrompt();

  const promptChars = systemPrompt.length + userPrompt.length;
  logger.info(`Map context: ~${Math.ceil(promptChars / 4)} tokens (estimate)`);

  let plan;
  let totalTokens: number;
  let passes: number;
  let truncatedFiles: string[];
  try {
    const result = await withSpinner('Thinking...', async () =>
      callAIWithFileContext(projectRoot, providerConfig, systemPrompt, userPrompt),
    );
    plan = result.plan;
    totalTokens = result.totalTokens;
    passes = result.passes;
    truncatedFiles = result.truncatedFiles;
  } catch (err) {
    if (err instanceof AIResponseParseError) {
      logger.error('AI returned an unparseable response.', err.message);
    } else {
      logger.error('AI call failed.', (err as Error).message);
    }
    process.exitCode = 1;
    return;
  }

  // Real (billed) tokens, sourced from the provider's usage block. Falls back
  // to 0 only when the provider didn't report usage — surface that so the
  // user knows the number is incomplete rather than zero by accident.
  if (totalTokens > 0) {
    logger.info(`Provider usage: ${totalTokens} tokens across ${passes} pass(es) — ${providerConfig.provider}/${providerConfig.model}`);
  } else {
    logger.info(`Provider did not report token usage (${providerConfig.provider}/${providerConfig.model})`);
  }

  if (truncatedFiles.length > 0) {
    logger.info(chalk.yellow(`Skipped reading ${truncatedFiles.length} file(s) in pass 2 (byte budget hit):`));
    logger.list(truncatedFiles);
  }

  if (options.printPlan) {
    logger.blank();
    logger.banner('Raw Plan');
    console.log(JSON.stringify(plan, null, 2));
    logger.blank();
  }

  if (plan.create.length === 0 && plan.modify.length === 0) {
    logger.info(chalk.dim(plan.summary));
    logger.blank();
    logger.info('AI returned an empty plan — nothing to do.');
    return;
  }

  logger.blank();
  logger.banner('AI Generation Plan');
  console.log(`  ${chalk.dim(plan.summary)}`);
  logger.blank();

  if (plan.create.length > 0) {
    logger.info(`Create ${plan.create.length} file(s):`);
    for (const file of plan.create) {
      console.log(`    ${chalk.green('+')} ${chalk.cyan(file.path)}`);
      console.log(`      ${chalk.dim(file.purpose)}`);
    }
    logger.blank();
  }

  if (plan.modify.length > 0) {
    logger.info(`Modify ${plan.modify.length} file(s):`);
    for (const file of plan.modify) {
      console.log(`    ${chalk.yellow('~')} ${chalk.cyan(file.path)}`);
      console.log(`      ${chalk.dim(file.purpose)}`);
    }
    logger.blank();
  }

  const preview = await previewPlan(projectRoot, config, plan);
  reportWarnings(preview.warnings);

  if (preview.diffs.length > 0) {
    logger.banner('Diff Preview');
    for (const entry of preview.diffs) {
      console.log(entry.diff);
      console.log();
    }
  }

  if (options.dryRun) {
    logger.info(chalk.dim('Dry run — no files were changed.'));
    return;
  }

  if (!options.yes) {
    const inquirer = await import('inquirer');
    const { proceed } = await inquirer.default.prompt<{ proceed: boolean }>([{
      type: 'confirm',
      name: 'proceed',
      message: 'Apply this plan?',
      default: true,
    }]);

    if (!proceed) {
      logger.info('Aborted.');
      return;
    }
  }

  const result = await withSpinner('Generating code from plan', async () => {
    return executePlan(projectRoot, config, plan);
  });

  reportWarnings(result.warnings);

  if (config.map.autoUpdate && map) {
    await withSpinner('Updating project map', async () => {
      for (const filePath of result.createdFiles) {
        const action = plan.create.find((a) => a.path === filePath);
        if (action) await mapManager.registerEntry(action.path, action.purpose);
      }
    });
  }

  // History recorded only when something actually changed — no point in
  // creating a no-op undo entry the user can't usefully revert.
  if (result.operations.length > 0) {
    const history = new HistoryManager(projectRoot);
    const label = options.retry ? `ai --retry "${effectiveRequest}"` : `ai "${effectiveRequest}"`;
    await history.record(`${label} (${providerConfig.provider}/${providerConfig.model})`, result.operations);

    // Persist snapshot for future `--retry` invocations. We always write
    // the ORIGINAL request (not the augmented retry prompt) so repeated
    // retries keep the operator's real intent, not a prompt-chain drift.
    await saveLastRun(projectRoot, {
      request: effectiveRequest,
      provider: providerConfig.provider,
      model: providerConfig.model,
      summary: plan.summary,
      createdFiles: result.createdFiles,
      modifiedFiles: result.modifiedFiles,
      timestamp: new Date().toISOString(),
    });
  }

  logger.blank();
  if (result.operations.length === 0) {
    logger.info('No files changed.');
    return;
  }
  logger.success('AI generation complete');
  if (result.createdFiles.length > 0) {
    logger.info('Created:');
    logger.list(result.createdFiles);
  }
  if (result.modifiedFiles.length > 0) {
    logger.info('Modified:');
    logger.list(result.modifiedFiles);
  }
  logger.blank();
}

/**
 * Render execution / preview warnings as a single grouped block. Each
 * reason maps to a short human description; unknown reasons fall through
 * with the raw enum value so we don't silently drop new ones.
 */
function reportWarnings(warnings: ExecutionWarning[]): void {
  if (warnings.length === 0) return;
  const labels: Record<ExecutionWarning['reason'], string> = {
    'skip-existing': 'already exists (skipped)',
    'skip-missing': 'target file missing (skipped)',
    'outside-root': 'path resolves outside project root (rejected)',
    'noop-modify': 'modify action had no imports/registrations/methods to inject — re-prompt with more specifics',
  };
  logger.blank();
  logger.info(chalk.yellow('Warnings:'));
  for (const w of warnings) {
    const label = labels[w.reason] ?? w.reason;
    console.log(`    ${chalk.yellow('!')} ${w.path} — ${label}`);
  }
}

async function loadLastRun(projectRoot: string): Promise<LastRunSnapshot | null> {
  const p = path.join(projectRoot, LAST_RUN_PATH);
  if (!(await fs.pathExists(p))) return null;
  try {
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isSnapshot(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isSnapshot(v: unknown): v is LastRunSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s['request'] === 'string'
    && typeof s['model'] === 'string'
    && (s['provider'] === 'openai' || s['provider'] === 'anthropic')
    && typeof s['timestamp'] === 'string';
}

async function saveLastRun(projectRoot: string, snap: LastRunSnapshot): Promise<void> {
  const p = path.join(projectRoot, LAST_RUN_PATH);
  await fs.ensureDir(path.dirname(p));
  await fs.writeFile(p, JSON.stringify(snap, null, 2) + '\n', 'utf-8');
}

/**
 * Collect `tsc --noEmit` errors for retry feedback. Uses the project's
 * local tsc (node_modules/.bin) when present, falling back to `npx tsc`
 * otherwise. Output is filtered to `error TS` lines, capped at
 * MAX_ERROR_LINES and MAX_ERROR_BYTES so a catastrophic breakage can't
 * blow the prompt budget.
 */
type TypecheckResult =
  | { kind: 'no-tsconfig' }
  | { kind: 'clean' }
  | { kind: 'errors'; text: string; lineCount: number; bytes: number };

async function collectTypecheckErrors(projectRoot: string): Promise<TypecheckResult> {
  if (!(await fs.pathExists(path.join(projectRoot, 'tsconfig.json')))) {
    return { kind: 'no-tsconfig' };
  }

  const localTsc = path.join(projectRoot, 'node_modules', '.bin', 'tsc');
  const hasLocal = await fs.pathExists(localTsc);
  const cmd = hasLocal ? localTsc : 'npx';
  const args = hasLocal
    ? ['--noEmit', '--pretty', 'false']
    : ['--yes', 'tsc', '--noEmit', '--pretty', 'false'];

  const out = await new Promise<string>((resolve) => {
    const child = spawn(cmd, args, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (b: Buffer): void => { buf += b.toString('utf-8'); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    // 2-minute ceiling — tsc on a scaffolded project is fast, but we'd
    // rather abandon than hang the CLI.
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', () => { clearTimeout(timer); resolve(buf); });
  });

  const errorLines = out
    .split('\n')
    .filter((l) => /error TS\d+/.test(l));

  if (errorLines.length === 0) return { kind: 'clean' };

  // Trim in two dimensions: line count and byte budget. Byte cap wins —
  // if a single line is pathologically long it still gets truncated.
  const trimmedLines = errorLines.slice(0, MAX_ERROR_LINES);
  let text = trimmedLines.join('\n');
  if (Buffer.byteLength(text, 'utf-8') > MAX_ERROR_BYTES) {
    text = text.slice(0, MAX_ERROR_BYTES) + '\n… (truncated)';
  }

  return {
    kind: 'errors',
    text,
    lineCount: errorLines.length,
    bytes: Buffer.byteLength(text, 'utf-8'),
  };
}

function resolveProvider(options: AIOptions): AIProviderConfig | null {
  const provider = options.provider as 'openai' | 'anthropic' | undefined;

  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) return null;
    return { provider: 'openai', apiKey, model: options.model ?? DEFAULT_MODELS.openai };
  }

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) return null;
    return { provider: 'anthropic', apiKey, model: options.model ?? DEFAULT_MODELS.anthropic };
  }

  // Auto-detect from environment.
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey, model: options.model ?? DEFAULT_MODELS.anthropic };
  }

  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    return { provider: 'openai', apiKey: openaiKey, model: options.model ?? DEFAULT_MODELS.openai };
  }

  return null;
}
