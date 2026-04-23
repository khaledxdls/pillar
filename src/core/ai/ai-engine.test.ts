import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'fs-extra';
import {
  buildContext,
  buildPrompt,
  callAIProvider,
  callAIWithFileContext,
  getSystemPrompt,
} from './ai-engine.js';
import type { PillarConfig } from '../config/index.js';
import type { ProjectMap } from '../map/types.js';
import type { AIProviderConfig } from './types.js';

const CONFIG: PillarConfig = {
  project: {
    name: 'test-app',
    platform: 'web',
    category: 'api',
    stack: 'express',
    language: 'typescript',
    architecture: 'feature-first',
    packageManager: 'npm',
  },
  database: { type: 'postgresql', orm: 'prisma' },
  generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
  map: { autoUpdate: true, format: ['json', 'markdown'] },
  extras: { docker: false, linting: false, gitHooks: false },
};

const ANTHROPIC: AIProviderConfig = { provider: 'anthropic', apiKey: 'sk-test', model: 'claude-test' };
const OPENAI: AIProviderConfig = { provider: 'openai', apiKey: 'sk-test', model: 'gpt-test' };

const VALID_PLAN = {
  summary: 'Test plan',
  create: [{ path: 'src/foo.ts', purpose: 'A foo', kind: 'service' }],
  modify: [],
};

/**
 * Build a Response shim. We construct minimal `Response`-like objects
 * because `undici`'s real Response is heavy and the engine only touches
 * `.ok`, `.status`, `.headers.get`, `.text()`, and `.json()`.
 */
function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? init.headers?.[k] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function textResponse(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? init.headers?.[k] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body),
  } as unknown as Response;
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Reduce sleep delays in retry loop so tests stay fast. Default backoff
  // (1s, 2s) is fine in prod but would balloon test time to ~6s/run.
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 5 });
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('buildContext', () => {
  it('reports a missing-map fallback string', () => {
    const ctx = buildContext(CONFIG, null);
    expect(ctx.mapSummary).toContain('No project map');
    expect(ctx.testFramework).toBe('vitest');
  });

  it('summarizes a small map without truncation', () => {
    const map: ProjectMap = {
      meta: { name: 'x', stack: 'express', language: 'ts', architecture: 'feature-first', created: '', lastUpdated: '' },
      structure: {
        src: {
          purpose: 'source',
          children: {
            'foo.ts': { purpose: 'foo file' },
            'bar.ts': { purpose: 'bar file' },
          },
        },
      },
    };
    const ctx = buildContext(CONFIG, map);
    expect(ctx.mapSummary).toContain('src/ — source');
    expect(ctx.mapSummary).toContain('src/foo.ts — foo file');
    expect(ctx.mapSummary).not.toContain('omitted');
  });

  it('caps the map summary at MAX_MAP_LINES with a truncation notice', () => {
    // Build a flat map of 250 children — well above the 200 cap.
    const children: Record<string, { purpose: string }> = {};
    for (let i = 0; i < 250; i++) children[`f${i}.ts`] = { purpose: `file ${i}` };
    const map: ProjectMap = {
      meta: { name: 'x', stack: 'express', language: 'ts', architecture: 'feature-first', created: '', lastUpdated: '' },
      structure: { src: { purpose: 'source', children } },
    };
    const ctx = buildContext(CONFIG, map);
    expect(ctx.mapSummary).toMatch(/\d+ more entries omitted/);
    // The summary's line count should be MAX_MAP_LINES + 1 (the notice).
    const lines = ctx.mapSummary.split('\n');
    expect(lines.length).toBe(201);
  });
});

describe('buildPrompt', () => {
  it('includes test framework in the rendered prompt', () => {
    const ctx = buildContext(CONFIG, null);
    const prompt = buildPrompt(ctx, 'add health route');
    expect(prompt).toContain('Test framework: vitest');
    expect(prompt).toContain('User request: add health route');
  });

  it('emits stack-specific API hints', () => {
    const stacks: Array<[PillarConfig['project']['stack'], string]> = [
      ['express', 'Router()'],
      ['fastify', 'FastifyInstance'],
      ['hono', 'new Hono()'],
      ['nestjs', '@Controller'],
      ['nextjs', 'NextResponse'],
    ];
    for (const [stack, marker] of stacks) {
      const ctx = buildContext({ ...CONFIG, project: { ...CONFIG.project, stack } }, null);
      const prompt = buildPrompt(ctx, 'x');
      expect(prompt, `stack=${stack}`).toContain(marker);
      expect(prompt, `stack=${stack}`).toContain(`STACK CONSTRAINT — generated code MUST target ${stack.toUpperCase()}`);
    }
  });
});

describe('callAIProvider — Anthropic', () => {
  it('returns the parsed plan and real usage tokens from tool_use', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 123, output_tokens: 45 },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await callAIProvider(ANTHROPIC, 'system', 'user');
    expect(result.plan.summary).toBe('Test plan');
    expect(result.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it('sends the system prompt with cache_control: ephemeral', async () => {
    let captured: { body?: unknown } = {};
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(init!.body as string);
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await callAIProvider(ANTHROPIC, getSystemPrompt(), 'user');
    const body = captured.body as { system: Array<{ type: string; cache_control?: unknown }> };
    expect(body.system[0]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('sums cache_creation + cache_read tokens into inputTokens', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 5 },
      }),
    ) as unknown as typeof fetch;
    const result = await callAIProvider(ANTHROPIC, 'sys', 'usr');
    expect(result.usage.inputTokens).toBe(160);
  });

  it('falls back to text blocks when tool_use is absent', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'text', text: JSON.stringify(VALID_PLAN) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    const result = await callAIProvider(ANTHROPIC, 'sys', 'usr');
    expect(result.plan.summary).toBe('Test plan');
  });
});

describe('callAIProvider — OpenAI', () => {
  it('uses response_format: json_schema', async () => {
    let captured: { body?: unknown } = {};
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      captured.body = JSON.parse(init!.body as string);
      return jsonResponse({
        choices: [{ message: { content: JSON.stringify(VALID_PLAN) } }],
        usage: { prompt_tokens: 200, completion_tokens: 50 },
      });
    }) as unknown as typeof fetch;

    const result = await callAIProvider(OPENAI, 'system', 'user');
    expect(result.plan.summary).toBe('Test plan');
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 50 });
    const body = captured.body as { response_format: { type: string; json_schema: { name: string } } };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('pillar_plan');
  });

  it('throws on empty response content', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: '' } }], usage: {} }),
    ) as unknown as typeof fetch;
    await expect(callAIProvider(OPENAI, 'sys', 'usr')).rejects.toThrow(/Empty response/);
  });
});

describe('callAIProvider — schema validation', () => {
  it('rejects a plan with an unknown kind', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: {
          summary: 'x',
          create: [{ path: 'src/x.ts', purpose: 'p', kind: 'totally-fake' }],
          modify: [],
        } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    await expect(callAIProvider(ANTHROPIC, 'sys', 'usr'))
      .rejects.toThrow(/AI plan validation failed/);
  });

  it('rejects a plan with a path-traversal payload', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: {
          summary: 'x',
          create: [{ path: '../etc/passwd', purpose: 'p', kind: 'generic' }],
          modify: [],
        } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ) as unknown as typeof fetch;
    await expect(callAIProvider(ANTHROPIC, 'sys', 'usr')).rejects.toThrow(/validation failed/);
  });
});

describe('fetch retry + timeout', () => {
  it('retries on 503 and succeeds', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 3) return textResponse('overloaded', { status: 503 });
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    await vi.runAllTimersAsync();
    const promise = callAIProvider(ANTHROPIC, 'sys', 'usr');
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(calls).toBe(3);
    expect(result.plan.summary).toBe('Test plan');
  });

  it('honors Retry-After (seconds) on 429', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) return textResponse('rate limited', { status: 429, headers: { 'retry-after': '1' } });
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const promise = callAIProvider(ANTHROPIC, 'sys', 'usr');
    await vi.runAllTimersAsync();
    await promise;
    expect(calls).toBe(2);
  });

  it('does NOT retry on a non-retryable 4xx', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return textResponse('bad key', { status: 401 });
    }) as unknown as typeof fetch;

    await expect(callAIProvider(ANTHROPIC, 'sys', 'usr')).rejects.toThrow(/401/);
    expect(calls).toBe(1);
  });

  it('exhausts retries and throws after 3 attempts on persistent 5xx', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return textResponse('still bad', { status: 502 });
    }) as unknown as typeof fetch;

    // Attach the rejection handler BEFORE advancing timers — otherwise the
    // rejection surfaces as "unhandled" for a microtask before expect()
    // wires up, and Node logs a warning that trips Vitest's error reporter.
    const assertion = expect(callAIProvider(ANTHROPIC, 'sys', 'usr')).rejects.toThrow(/502/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(3);
  });

  it('treats AbortError as a timeout and retries', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls < 2) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const promise = callAIProvider(ANTHROPIC, 'sys', 'usr');
    await vi.runAllTimersAsync();
    await promise;
    expect(calls).toBe(2);
  });
});

describe('callAIWithFileContext — two-pass flow', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-engine-'));
  });
  afterEach(async () => {
    await fs.remove(tmp);
  });

  it('skips pass 2 when plan has no modify actions', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: VALID_PLAN }],
        usage: { input_tokens: 10, output_tokens: 5 },
      });
    }) as unknown as typeof fetch;

    const result = await callAIWithFileContext(tmp, ANTHROPIC, 'sys', 'usr');
    expect(calls).toBe(1);
    expect(result.passes).toBe(1);
    expect(result.totalTokens).toBe(15);
    expect(result.truncatedFiles).toEqual([]);
  });

  it('runs pass 2 when modify targets exist on disk', async () => {
    const target = path.join(tmp, 'src/app.ts');
    await fs.ensureDir(path.dirname(target));
    await fs.writeFile(target, 'const x = 1;', 'utf-8');

    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      const plan = calls === 1
        ? { summary: 's', create: [], modify: [{ path: 'src/app.ts', purpose: 'p', kind: 'generic' }] }
        : { summary: 'refined', create: [], modify: [{ path: 'src/app.ts', purpose: 'p', kind: 'generic' }] };
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: plan }],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    }) as unknown as typeof fetch;

    const result = await callAIWithFileContext(tmp, ANTHROPIC, 'sys', 'usr');
    expect(calls).toBe(2);
    expect(result.passes).toBe(2);
    expect(result.plan.summary).toBe('refined');
    expect(result.totalTokens).toBe(240); // (100+20) × 2
  });

  it('reports truncated files when pass-2 byte budget is exhausted', async () => {
    // Build two files: first fits, second pushes over the 32KB budget.
    const big1 = path.join(tmp, 'src/big1.ts');
    const big2 = path.join(tmp, 'src/big2.ts');
    await fs.ensureDir(path.dirname(big1));
    await fs.writeFile(big1, 'a'.repeat(20 * 1024), 'utf-8');
    await fs.writeFile(big2, 'b'.repeat(20 * 1024), 'utf-8');

    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: {
          summary: 's',
          create: [],
          modify: [
            { path: 'src/big1.ts', purpose: 'p', kind: 'generic' },
            { path: 'src/big2.ts', purpose: 'p', kind: 'generic' },
          ],
        } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ) as unknown as typeof fetch;

    const result = await callAIWithFileContext(tmp, ANTHROPIC, 'sys', 'usr');
    expect(result.truncatedFiles).toEqual(['src/big2.ts']);
  });

  it('skips pass 2 when no modify targets exist on disk', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return jsonResponse({
        content: [{ type: 'tool_use', name: 'emit_plan', input: {
          summary: 's', create: [],
          modify: [{ path: 'src/never.ts', purpose: 'p', kind: 'generic' }],
        } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const result = await callAIWithFileContext(tmp, ANTHROPIC, 'sys', 'usr');
    expect(calls).toBe(1);
    expect(result.passes).toBe(1);
  });
});
