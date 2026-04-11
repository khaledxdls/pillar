import chalk from 'chalk';
import { loadConfig } from '../core/config/index.js';
import { MapManager } from '../core/map/index.js';
import { logger, findProjectRoot, withSpinner } from '../utils/index.js';

interface MapOptions {
  refresh?: boolean;
  validate?: boolean;
  export?: string;
}

export async function mapCommand(options: MapOptions): Promise<void> {
  const projectRoot = await findProjectRoot();
  if (!projectRoot) {
    logger.error('Not inside a Pillar project.', 'Run "pillar init" first.');
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig(projectRoot);
  const mapManager = new MapManager(projectRoot);

  if (options.refresh) {
    await withSpinner('Refreshing project map', async () => {
      await mapManager.refresh(config);
    });
    logger.success('Project map refreshed');
    return;
  }

  if (options.validate) {
    const result = await mapManager.validate();

    if (result.valid) {
      logger.success('Project map is in sync with the filesystem');
    } else {
      if (result.unmappedFiles.length > 0) {
        logger.warn(`${result.unmappedFiles.length} unmapped file(s):`);
        logger.list(result.unmappedFiles);
      }
      if (result.missingFiles.length > 0) {
        logger.warn(`${result.missingFiles.length} missing file(s) referenced in map:`);
        logger.list(result.missingFiles);
      }
      logger.blank();
      logger.info('Run "pillar map --refresh" to rebuild the map');
    }
    return;
  }

  if (options.export) {
    const map = await mapManager.load();
    if (!map) {
      logger.warn('No project map found. Run "pillar map --refresh" to generate one.');
      return;
    }

    if (options.export === 'json') {
      console.log(JSON.stringify(map, null, 2));
    } else {
      console.log(mapManager.renderMarkdown(map));
    }
    return;
  }

  // Default: display the map
  const map = await mapManager.load();
  if (!map) {
    logger.warn('No project map found. Run "pillar map --refresh" to generate one.');
    return;
  }

  console.log(mapManager.renderMarkdown(map));
}
