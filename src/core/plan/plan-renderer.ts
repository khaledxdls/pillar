import chalk from 'chalk';
import { generateDiff, generateCreatePreview } from '../../utils/diff.js';
import type { Plan, PlannedChange } from './types.js';

export interface RenderOptions {
  /** Maximum preview lines for newly created files. Default 40. */
  maxCreateLines?: number;
  /** If true, hide `modify` changes whose content is unchanged. Default true. */
  hideUnchanged?: boolean;
  /** If false, suppress ANSI colors. Default respects chalk's detection. */
  color?: boolean;
}

/**
 * Render a `Plan` as human-readable output for `--preview`.
 *
 * Layout:
 *
 *   PREVIEW — <command>
 *     Summary: +N ~M -K (↻J moves) [±U unchanged]
 *
 *   [per file] diff or create-preview
 *
 *   [warnings block, if any]
 *   [notes block, if any]
 *   [footer] "Nothing will be written. Re-run without --preview to apply."
 *
 * Returns a plain string so callers can log, pipe, or snapshot-test it.
 */
export function renderPlan(plan: Plan, options: RenderOptions = {}): string {
  const maxCreateLines = options.maxCreateLines ?? 40;
  const hideUnchanged = options.hideUnchanged ?? true;
  const paint = options.color === false ? noColor : chalk;

  const out: string[] = [];
  out.push('');
  out.push(`  ${paint.bold.cyan('PREVIEW')} ${paint.dim('—')} ${paint.bold(plan.command)}`);
  out.push(`  ${renderSummary(plan, paint)}`);
  out.push('');

  if (plan.changes.length === 0) {
    out.push(`  ${paint.dim('No filesystem changes.')}`);
  }

  for (const change of plan.changes) {
    if (hideUnchanged && change.kind === 'modify' && change.oldContent === change.newContent) {
      continue;
    }
    out.push(renderChange(change, { maxCreateLines, paint }));
    out.push('');
  }

  if (plan.warnings.length > 0) {
    out.push(`  ${paint.bold.yellow('Warnings')}`);
    for (const w of plan.warnings) {
      const where = w.path ? paint.dim(`  [${w.path}]`) : '';
      out.push(`    ${paint.yellow('!')} ${w.message}${where}`);
    }
    out.push('');
  }

  if (plan.notes && plan.notes.length > 0) {
    for (const n of plan.notes) {
      out.push(`  ${paint.bold.cyan(n.title)}`);
      out.push('');
      out.push(indent(n.body, 4));
      out.push('');
    }
  }

  out.push(`  ${paint.dim('Nothing was written. Re-run without --preview to apply.')}`);
  out.push('');

  return out.join('\n');
}

function renderSummary(plan: Plan, paint: Paint): string {
  const s = plan.summary;
  const parts = [
    `${paint.green('+' + s.created)} created`,
    `${paint.yellow('~' + s.modified)} modified`,
    `${paint.red('-' + s.deleted)} deleted`,
  ];
  if (s.moved > 0) parts.push(`${paint.cyan('↻' + s.moved)} moved`);
  if (s.unchanged > 0) parts.push(paint.dim(`±${s.unchanged} unchanged`));
  return parts.join(paint.dim(' · '));
}

function renderChange(
  change: PlannedChange,
  ctx: { maxCreateLines: number; paint: Paint },
): string {
  const { paint } = ctx;
  const label = labelFor(change, paint);
  const header = `  ${label} ${paint.bold(change.path)}${
    change.purpose ? paint.dim(`  — ${change.purpose}`) : ''
  }`;

  switch (change.kind) {
    case 'create': {
      const preview = generateCreatePreview(change.newContent ?? '', change.path, ctx.maxCreateLines);
      return `${header}\n${indent(preview, 2)}`;
    }
    case 'modify': {
      if (change.oldContent === change.newContent) {
        return `${header}\n    ${paint.dim('(no changes)')}`;
      }
      const diff = generateDiff(change.oldContent ?? '', change.newContent ?? '', change.path);
      return `${header}\n${indent(diff, 2)}`;
    }
    case 'delete': {
      const preview = (change.oldContent ?? '').split('\n').slice(0, 10).map((l) => paint.red(`-${l}`)).join('\n');
      const extra = (change.oldContent ?? '').split('\n').length > 10
        ? `\n    ${paint.dim('...')}` : '';
      return `${header}\n${indent(preview, 2)}${extra}`;
    }
    case 'move': {
      const arrow = `${paint.dim('from')} ${change.fromPath ?? '?'} ${paint.dim('→')} ${change.path}`;
      return `${header}\n    ${arrow}`;
    }
  }
}

function labelFor(change: PlannedChange, paint: Paint): string {
  switch (change.kind) {
    case 'create':
      return paint.green.bold('create');
    case 'modify':
      return paint.yellow.bold('modify');
    case 'delete':
      return paint.red.bold('delete');
    case 'move':
      return paint.cyan.bold(' move ');
  }
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => (l.length === 0 ? l : pad + l))
    .join('\n');
}

/**
 * Minimal chalk-compatible shim used when `color: false` is requested.
 * Only the methods the renderer actually uses are implemented — no need
 * to cover the full chalk surface.
 */
type Paint = typeof chalk;
const noColor = ((): Paint => {
  const id = (s: string): string => s;
  const handler: ProxyHandler<object> = {
    get(_, prop: string | symbol) {
      if (prop === 'bold' || typeof prop === 'symbol') return proxy;
      return new Proxy(id as unknown as object, handler);
    },
    apply(_t, _this, args: unknown[]) {
      return String(args[0] ?? '');
    },
  };
  const proxy = new Proxy(id as unknown as object, handler);
  return proxy as unknown as Paint;
})();
