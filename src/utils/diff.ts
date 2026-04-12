import chalk from 'chalk';

/**
 * Generate a minimal unified-style diff between two strings.
 * No external dependencies — pure line-by-line comparison with context.
 */
export function generateDiff(oldContent: string, newContent: string, filePath: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const hunks = computeHunks(oldLines, newLines);
  if (hunks.length === 0) return '';

  const header = [
    chalk.dim(`--- a/${filePath}`),
    chalk.dim(`+++ b/${filePath}`),
  ];

  const body: string[] = [];
  for (const hunk of hunks) {
    body.push(chalk.cyan(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`));
    for (const line of hunk.lines) {
      switch (line.type) {
        case 'context':
          body.push(chalk.dim(` ${line.content}`));
          break;
        case 'add':
          body.push(chalk.green(`+${line.content}`));
          break;
        case 'remove':
          body.push(chalk.red(`-${line.content}`));
          break;
      }
    }
  }

  return [...header, ...body].join('\n');
}

/**
 * Show a preview of a new file being created (first N lines).
 */
export function generateCreatePreview(content: string, filePath: string, maxLines = 20): string {
  const lines = content.split('\n');
  const previewLines = lines.slice(0, maxLines);
  const truncated = lines.length > maxLines;

  const header = chalk.dim(`+++ b/${filePath} (new file)`);
  const body = previewLines.map((l) => chalk.green(`+${l}`));

  if (truncated) {
    body.push(chalk.dim(`  ... ${lines.length - maxLines} more lines`));
  }

  return [header, ...body].join('\n');
}

interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
}

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

const CONTEXT_LINES = 3;

/**
 * Compute diff hunks using the Myers-like LCS algorithm.
 * Groups changes with surrounding context lines.
 */
function computeHunks(oldLines: string[], newLines: string[]): Hunk[] {
  // Build edit script using LCS
  const lcs = computeLCS(oldLines, newLines);
  const edits = buildEditScript(oldLines, newLines, lcs);

  // Group edits into hunks with context
  return groupIntoHunks(edits, oldLines.length, newLines.length);
}

/**
 * Compute LCS table for two line arrays.
 * Memory-efficient: only stores the boolean directions, not full strings.
 */
function computeLCS(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  return dp;
}

interface Edit {
  type: 'equal' | 'add' | 'remove';
  oldIdx: number;
  newIdx: number;
  content: string;
}

function buildEditScript(oldLines: string[], newLines: string[], dp: number[][]): Edit[] {
  const edits: Edit[] = [];
  let i = oldLines.length;
  let j = newLines.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      edits.push({ type: 'equal', oldIdx: i - 1, newIdx: j - 1, content: oldLines[i - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      edits.push({ type: 'add', oldIdx: i, newIdx: j - 1, content: newLines[j - 1]! });
      j--;
    } else {
      edits.push({ type: 'remove', oldIdx: i - 1, newIdx: j, content: oldLines[i - 1]! });
      i--;
    }
  }

  return edits.reverse();
}

function groupIntoHunks(edits: Edit[], oldLen: number, newLen: number): Hunk[] {
  // Find change ranges
  const changeIndices: number[] = [];
  for (let i = 0; i < edits.length; i++) {
    if (edits[i]!.type !== 'equal') {
      changeIndices.push(i);
    }
  }

  if (changeIndices.length === 0) return [];

  // Group changes that are within CONTEXT_LINES of each other
  const groups: Array<{ start: number; end: number }> = [];
  let groupStart = changeIndices[0]!;
  let groupEnd = changeIndices[0]!;

  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - groupEnd <= CONTEXT_LINES * 2) {
      groupEnd = idx;
    } else {
      groups.push({ start: groupStart, end: groupEnd });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  groups.push({ start: groupStart, end: groupEnd });

  // Convert groups to hunks with context
  const hunks: Hunk[] = [];
  for (const group of groups) {
    const contextStart = Math.max(0, group.start - CONTEXT_LINES);
    const contextEnd = Math.min(edits.length - 1, group.end + CONTEXT_LINES);

    const lines: DiffLine[] = [];
    let oldStart = Infinity;
    let newStart = Infinity;
    let oldCount = 0;
    let newCount = 0;

    for (let i = contextStart; i <= contextEnd; i++) {
      const edit = edits[i]!;

      switch (edit.type) {
        case 'equal':
          lines.push({ type: 'context', content: edit.content });
          oldStart = Math.min(oldStart, edit.oldIdx + 1);
          newStart = Math.min(newStart, edit.newIdx + 1);
          oldCount++;
          newCount++;
          break;
        case 'add':
          lines.push({ type: 'add', content: edit.content });
          newStart = Math.min(newStart, edit.newIdx + 1);
          newCount++;
          break;
        case 'remove':
          lines.push({ type: 'remove', content: edit.content });
          oldStart = Math.min(oldStart, edit.oldIdx + 1);
          oldCount++;
          break;
      }
    }

    if (oldStart === Infinity) oldStart = 1;
    if (newStart === Infinity) newStart = 1;

    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }

  return hunks;
}
