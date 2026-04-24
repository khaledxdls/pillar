/**
 * Shared helpers for commands that support `--preview` (and the
 * backwards-compatible `--dry-run` alias).
 *
 * A command wires preview support by:
 *   1. Accepting `{ preview?, dryRun? }` in its options
 *   2. Calling `isPreview(options)` to collapse both flags to one boolean
 *   3. Building a `Plan` via the appropriate planner (pure, no I/O writes)
 *   4. If preview → `renderPlan()` and return
 *      Else         → `new PlanExecutor(root).execute(plan)` and record
 *                     the returned operations in history
 */

import { logger } from '../utils/index.js';
import { renderPlan } from '../core/plan/index.js';
import type { Plan } from '../core/plan/index.js';

export interface PreviewFlags {
  preview?: boolean;
  /** Kept for backward compatibility — aliased to --preview. */
  dryRun?: boolean;
}

let dryRunNoticeShown = false;

/**
 * Resolve the preview flag across both `--preview` and legacy `--dry-run`.
 * Emits a one-time, non-fatal deprecation notice when `--dry-run` is used
 * so existing scripts keep working while users migrate.
 */
export function isPreview(options: PreviewFlags): boolean {
  if (options.preview) return true;
  if (options.dryRun) {
    if (!dryRunNoticeShown) {
      dryRunNoticeShown = true;
      logger.warn('--dry-run is deprecated; use --preview for full diff output.');
    }
    return true;
  }
  return false;
}

/**
 * Print a rendered plan to stdout. Respects NO_COLOR / non-TTY by default.
 */
export function printPlan(plan: Plan): void {
  const color = process.stdout.isTTY === true && !process.env['NO_COLOR'];
  process.stdout.write(renderPlan(plan, { color }));
}
