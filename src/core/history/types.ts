export interface HistoryEntry {
  id: string;
  timestamp: string;
  command: string;
  operations: FileOperation[];
}

export interface FileOperation {
  type: 'create' | 'modify' | 'delete' | 'move';
  path: string;
  previousContent?: string;
  /** Original path before a move operation. */
  fromPath?: string;
}

export interface History {
  entries: HistoryEntry[];
}
