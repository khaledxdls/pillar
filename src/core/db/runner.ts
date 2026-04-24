import { spawn } from 'node:child_process';
import type { CommandPlan, RunContext, RunResult } from './types.js';
import { MigrationError } from './types.js';

export interface RunOptions {
  /**
   * Stream child stdout/stderr to the parent TTY as it arrives. When
   * true, `result.stdout` / `result.stderr` are empty — the bytes went
   * straight to the user's terminal. When false, output is buffered and
   * returned on the result.
   */
  stream?: boolean;
  /**
   * Stdin is inherited by default (so prompts from child CLIs like
   * `prisma migrate dev` work interactively). Set to `'ignore'` for
   * non-interactive / CI paths.
   */
  stdin?: 'inherit' | 'ignore';
}

/**
 * Run a `CommandPlan` as a child process.
 *
 * Policy:
 *   - Uses `spawn` with argv (no shell interpolation — no injection risk
 *     even when `plan.argv` contains user-supplied strings).
 *   - Streams child output by default: CLI migrations can take minutes,
 *     and the user expects live feedback.
 *   - Captures stderr tail (last 20 lines) on failure even when
 *     streaming, so error messages have something actionable.
 *   - Forwards the parent env plus `plan.env` overrides; never clears
 *     the parent env (child CLIs need PATH, HOME, DATABASE_URL, etc.).
 */
export async function runCommand(
  plan: CommandPlan,
  ctx: RunContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const stream = options.stream ?? true;
  const stdin = options.stdin ?? 'inherit';
  const started = Date.now();

  const env = { ...process.env, ...(plan.env ?? {}) };
  const cwd = plan.cwd ?? ctx.cwd ?? ctx.projectRoot;

  const [executable, ...args] = plan.argv;
  if (!executable) {
    throw new MigrationError(plan.label, -1, 'empty argv');
  }

  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: [stdin, stream ? 'inherit' : 'pipe', stream ? 'pipe' : 'pipe'],
      // shell: false is implicit and required — we rely on it for safety.
    });

    let stdout = '';
    let stderr = '';
    const stderrTailBuf: string[] = [];

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      if (stream) {
        process.stderr.write(text);
        // Also retain a rolling tail for the error message.
        for (const line of text.split('\n')) {
          stderrTailBuf.push(line);
          if (stderrTailBuf.length > 20) stderrTailBuf.shift();
        }
      } else {
        stderr += text;
      }
    });

    child.on('error', (err) => {
      reject(
        new MigrationError(
          plan.label,
          -1,
          err instanceof Error ? err.message : String(err),
        ),
      );
    });

    child.on('close', (code) => {
      const durationMs = Date.now() - started;
      const exitCode = code ?? -1;

      if (exitCode === 0) {
        resolve({ exitCode, stdout, stderr, durationMs });
        return;
      }
      const tail = stream ? stderrTailBuf.join('\n') : tailLines(stderr, 20);
      reject(new MigrationError(plan.label, exitCode, tail));
    });
  });
}

function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Build the `npx` / `yarn dlx` / `pnpm dlx` prefix appropriate for the
 * project's package manager. We prefer PM-native runners over bare `npx`
 * so lockfile-pinned versions are respected.
 *
 *   npm  → `npx --no-install <bin> …`
 *   yarn → `yarn <bin> …`                (yarn v1 + v3+ both work)
 *   pnpm → `pnpm exec <bin> …`
 *
 * We deliberately use `--no-install` for npm: auto-installing a
 * migration CLI mid-run hides misconfiguration that users should fix.
 * If the bin isn't present the error is crisp: "binary not found".
 */
export function packageManagerExec(
  pm: RunContext['packageManager'],
  bin: string,
  args: string[],
): { executable: string; argv: string[] } {
  switch (pm) {
    case 'yarn':
      return { executable: 'yarn', argv: ['yarn', bin, ...args] };
    case 'pnpm':
      return { executable: 'pnpm', argv: ['pnpm', 'exec', bin, ...args] };
    case 'npm':
    default:
      return { executable: 'npx', argv: ['npx', '--no-install', bin, ...args] };
  }
}
