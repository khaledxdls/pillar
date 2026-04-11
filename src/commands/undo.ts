import chalk from 'chalk';
import { HistoryManager } from '../core/history/index.js';
import { MapManager } from '../core/map/index.js';
import { loadConfig } from '../core/config/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

export async function undoCommand(): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const historyManager = new HistoryManager(projectRoot);
  const recent = await historyManager.recent(1);

  if (recent.length === 0) {
    logger.warn('Nothing to undo — history is empty');
    return;
  }

  const last = recent[0]!;
  logger.info(`Undoing: ${chalk.cyan(last.command)}`);
  logger.info(`Operations: ${last.operations.length} file(s)`);

  const entry = await withSpinner('Reverting changes', async () => {
    return historyManager.undo();
  });

  if (!entry) {
    logger.warn('Nothing to undo');
    return;
  }

  // Refresh the map to reflect reverted state
  const config = await loadConfig(projectRoot);
  if (config.map.autoUpdate) {
    await withSpinner('Updating project map', async () => {
      const mapManager = new MapManager(projectRoot);
      await mapManager.refresh(config);
    });
  }

  logger.blank();
  logger.success(`Reverted: ${entry.command}`);
  logger.info('Affected files:');
  logger.list(entry.operations.map((op) => `${op.type}: ${op.path}`));
  logger.blank();
}
