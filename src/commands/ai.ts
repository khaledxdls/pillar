import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { HistoryManager } from '../core/history/index.js';
import {
  buildContext,
  buildPrompt,
  callAIProvider,
  executePlan,
  getSystemPrompt,
  type AIProviderConfig,
  type AIGenerationPlan,
} from '../core/ai/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface AIOptions {
  provider?: string;
  model?: string;
  dryRun?: boolean;
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

  // Resolve AI provider config
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
      `pillar ai "${request}" --provider anthropic --model claude-sonnet-4-20250514`,
    ]);
    process.exitCode = 1;
    return;
  }

  // Build context from the map (minimal tokens)
  const context = buildContext(config, map);
  const userPrompt = buildPrompt(context, request);
  const systemPrompt = getSystemPrompt();

  // Show context size for transparency
  const contextTokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);
  logger.info(`Context size: ~${contextTokens} tokens (map-optimized)`);

  // Call AI
  const plan = await withSpinner('Thinking...', async () => {
    return callAIProvider(providerConfig, systemPrompt, userPrompt);
  });

  // Display the plan
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

  if (options.dryRun) {
    logger.info(chalk.dim('Dry run — no files were changed.'));
    return;
  }

  // Confirm before executing
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

  // Execute the plan
  const result = await withSpinner('Generating code from plan', async () => {
    return executePlan(projectRoot, config, plan);
  });

  // Update map
  if (config.map.autoUpdate && map) {
    await withSpinner('Updating project map', async () => {
      for (const file of plan.create) {
        await mapManager.registerEntry(file.path, file.purpose);
      }
    });
  }

  // Record history
  const history = new HistoryManager(projectRoot);
  await history.record(`ai "${request}"`, result.operations);

  logger.blank();
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

function resolveProvider(options: AIOptions): AIProviderConfig | null {
  const provider = options.provider as 'openai' | 'anthropic' | undefined;

  // Explicit provider
  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) return null;
    return { provider: 'openai', apiKey, model: options.model ?? 'gpt-4o' };
  }

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) return null;
    return { provider: 'anthropic', apiKey, model: options.model ?? 'claude-sonnet-4-20250514' };
  }

  // Auto-detect from environment
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    return { provider: 'anthropic', apiKey: anthropicKey, model: options.model ?? 'claude-sonnet-4-20250514' };
  }

  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    return { provider: 'openai', apiKey: openaiKey, model: options.model ?? 'gpt-4o' };
  }

  return null;
}
