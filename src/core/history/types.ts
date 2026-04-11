export interface HistoryEntry {
  id: string;
  timestamp: string;
  command: string;
  operations: FileOperation[];
}

export interface FileOperation {
  type: 'create' | 'modify' | 'delete';
  path: string;
  previousContent?: string;
}

export interface History {
  entries: HistoryEntry[];
}
