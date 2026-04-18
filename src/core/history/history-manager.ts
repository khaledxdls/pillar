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

  /**
   * Walk upwards from `dir`, removing directories that are empty as a result of
   * the undo. Stops at the project root and never touches the project root
   * itself, dot-directories (e.g. `.pillar`, `.git`), or paths outside the
   * project root.
   *
   * Originally only walked inside `src/`, which left orphaned empty folders
   * under `docs/`, `tests/`, `scripts/`, etc. after undoing generators that
   * write outside `src/`.
   */
  private async removeEmptyParents(dir: string): Promise<void> {
    const root = path.resolve(this.projectRoot);
    let current = path.resolve(dir);

    while (
      current !== root &&
      current.startsWith(root + path.sep) &&
      !path.basename(current).startsWith('.')
    ) {
      let contents: string[];
      try {
        contents = await fs.readdir(current);
      } catch {
        // Directory was already removed (or never existed) — nothing to do.
        break;
      }

      if (contents.length > 0) break;

      await fs.remove(current);
      current = path.dirname(current);
    }
  }
}
