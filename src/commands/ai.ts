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
}

export async function aiCommand(request: string, options: AIOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const mapManager = new MapManager(projectRoot);
  const map = await mapManager.load();

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
      `pillar ai "${request}"`,
      `pillar ai "${request}" --provider openai --model gpt-4o`,
      `pillar ai "${request}" --provider anthropic --model claude-sonnet-4-6`,
    ]);
    process.exitCode = 1;
    return;
  }

  const context = buildContext(config, map);
  const userPrompt = buildPrompt(context, request);
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
    await history.record(`ai "${request}" (${providerConfig.provider}/${providerConfig.model})`, result.operations);
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
