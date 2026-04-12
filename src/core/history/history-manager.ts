import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { PILLAR_HISTORY_PATH } from '../../utils/constants.js';
import type { History, HistoryEntry, FileOperation } from './types.js';

const MAX_HISTORY_ENTRIES = 50;

export class HistoryManager {
  private readonly historyPath: string;
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.historyPath = path.join(projectRoot, PILLAR_HISTORY_PATH);
  }

  /**
   * Record a set of file operations under a command.
   */
  async record(command: string, operations: FileOperation[]): Promise<HistoryEntry> {
    const history = await this.load();
    const entry: HistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      command,
      operations,
    };

    history.entries.push(entry);

    // Keep history bounded
    if (history.entries.length > MAX_HISTORY_ENTRIES) {
      history.entries = history.entries.slice(-MAX_HISTORY_ENTRIES);
    }

    await this.save(history);
    return entry;
  }

  /**
   * Undo the most recent operation.
   * Deletes created files and restores modified/deleted files.
   */
  async undo(): Promise<HistoryEntry | null> {
    const history = await this.load();
    const entry = history.entries.pop();
    if (!entry) return null;

    for (const op of entry.operations.reverse()) {
      const fullPath = path.join(this.projectRoot, op.path);

      switch (op.type) {
        case 'create': {
          await fs.remove(fullPath);
          // Clean up empty parent directories
          const dir = path.dirname(fullPath);
          await this.removeEmptyParents(dir);
          break;
        }
        case 'modify':
        case 'delete': {
          if (op.previousContent !== undefined) {
            await fs.ensureDir(path.dirname(fullPath));
            await fs.writeFile(fullPath, op.previousContent, 'utf-8');
          }
          break;
        }
        case 'move': {
          // Reverse the move: path is the new location, fromPath is the original
          if (op.fromPath) {
            const fromFull = path.join(this.projectRoot, op.fromPath);
            await fs.ensureDir(path.dirname(fromFull));
            await fs.move(fullPath, fromFull, { overwrite: false });
            // Clean up empty parent directories left behind
            const dir = path.dirname(fullPath);
            await this.removeEmptyParents(dir);
          }
          break;
        }
      }
    }

    await this.save(history);
    return entry;
  }

  /**
   * Get the last N history entries.
   */
  async recent(count: number = 10): Promise<HistoryEntry[]> {
    const history = await this.load();
    return history.entries.slice(-count);
  }

  private async load(): Promise<History> {
    if (!(await fs.pathExists(this.historyPath))) {
      return { entries: [] };
    }
    return fs.readJson(this.historyPath) as Promise<History>;
  }

  private async save(history: History): Promise<void> {
    await fs.ensureDir(path.dirname(this.historyPath));
    await fs.writeJson(this.historyPath, history, { spaces: 2 });
  }

  private async removeEmptyParents(dir: string): Promise<void> {
    const srcDir = path.join(this.projectRoot, 'src');
    let current = dir;

    while (current.startsWith(srcDir) && current !== srcDir) {
      const contents = await fs.readdir(current);
      if (contents.length > 0) break;
      await fs.remove(current);
      current = path.dirname(current);
    }
  }
}
