import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { ProjectMap } from '../map/types.js';
import type { AIGenerationPlan, AIRequestContext, AIProviderConfig } from './types.js';
import { aiGenerationPlanSchema, FILE_KINDS } from './plan-schema.js';
import { parseAIJson, AIResponseParseError } from './json-parser.js';

/** Current Anthropic API version. */
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Per-request HTTP timeout. Provider APIs occasionally hang under load —
 * without a ceiling the CLI freezes indefinitely. 60s comfortably covers
 * tool-use generation while still failing fast.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Retry policy for transient provider failures (429, 5xx, network errors).
 * Total worst-case latency: 60s + 1s + 60s + 2s + 60s ≈ 3min before bubbling
 * the error to the user. Plenty of room to outlast a brief outage without
 * making the CLI feel hung.
 */
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Soft caps on context size. The model still receives every entry — these
 * just prevent a 10k-file project from blowing the prompt to 50k tokens.
 *   MAX_MAP_LINES  — entries from the project map summary.
 *   MAX_PASS2_BYTES — combined byte budget for files re-read in pass 2.
 *     Raised from the previous 8KB; an Express `app.ts` plus one or two
 *     existing controllers regularly exceeds 8KB. 32KB ≈ 8k tokens still
 *     leaves headroom under any model context window.
 */
const MAX_MAP_LINES = 200;
const MAX_PASS2_BYTES = 32 * 1024;

/**
 * Default models — kept in one place so flags, docs, and the engine stay
 * aligned. Override with `--model` on the command line.
 */
export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
} as const;

/**
 * JSON Schema for the plan, used by both Anthropic tool-use and OpenAI
 * structured outputs (`response_format: json_schema`). Mirrors the Zod
 * schema in `plan-schema.ts`. The two must stay in sync — we generate the
 * `kind` enum from the canonical list to keep that automatic.
 */
const PLAN_TOOL_SCHEMA = {
  type: 'object',
  required: ['summary', 'create', 'modify'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    create: { type: 'array', items: { $ref: '#/definitions/fileAction' } },
    modify: { type: 'array', items: { $ref: '#/definitions/fileAction' } },
  },
  definitions: {
    fileAction: {
      type: 'object',
      required: ['path', 'purpose', 'kind'],
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        purpose: { type: 'string' },
        kind: { type: 'string', enum: [...FILE_KINDS] },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            additionalProperties: false,
            properties: { name: { type: 'string' }, type: { type: 'string' } },
          },
        },
        methods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'description'],
            additionalProperties: false,
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              signature: { type: 'string' },
            },
          },
        },
        content: { type: 'string' },
        imports: { type: 'array', items: { type: 'string' } },
        registrations: { type: 'array', items: { type: 'string' } },
      },
    },
  },
} as const;

const SYSTEM_PROMPT = `You are Pillar AI, an architecture-aware code planning assistant.
You receive a project context (stack, architecture, map) and a user request.
You return a structured JSON plan — you NEVER return raw code outside the plan structure.

Your response must be valid JSON matching this schema:
{
  "summary": "Brief description of what will be generated",
  "create": [
    {
      "path": "relative/path/to/file.ts",
      "purpose": "what this file does",
      "kind": "controller|service|repository|model|routes|validator|types|test|component|middleware|util|generic",
      "fields": [{"name": "fieldName", "type": "string|number|boolean|date"}],
      "methods": [{"name": "methodName", "description": "what it does"}],
      "content": "optional: full file content when the skeleton engine's default CRUD scaffold is NOT appropriate (e.g. a health check, auth middleware, custom utility)"
    }
  ],
  "modify": [
    {
      "path": "relative/path/to/existing/file.ts",
      "purpose": "what changes to make",
      "kind": "controller|service|routes|generic",
      "methods": [{"name": "newMethodName", "description": "what it does", "signature": "(arg: Type): Promise<ReturnType>"}],
      "imports": ["import { fooRouter } from './foo.routes.js';"],
      "registrations": ["app.use('/foo', fooRouter);"]
    }
  ]
}

Rules:
- Only return JSON. No markdown, no code blocks, no explanation.
- File paths must be relative to the project root, never start with '/' or 'C:\\\\', never contain '..'.
- Follow the project's architecture pattern (visible in the map).
- Use the project map to understand what already exists. Do NOT propose creating files that already appear in the map — propose modifying them instead.
- Minimize changes — only create/modify what's needed.
- Every file must have a purpose.
- The "kind" field MUST be one of the listed values.
- ESM imports MUST include the ".js" extension (Node16 module resolution) — write "./foo/bar.js", NOT "./foo/bar". This applies to every local import in "content" and in "imports".

DEFER TO THE CLI FOR BOILERPLATE. The Pillar CLI already handles repetitive work — do not regenerate it:
- Full CRUD resource scaffolding (controller + service + repository + model + routes + validator + types + test together): return an empty plan (create: [], modify: []) with summary: "Run: pillar add resource <name> --fields <name:type ...>"
- Middleware (cors, rate-limit, helmet, request-id, logging): return empty plan with summary: "Run: pillar add middleware <kind>"
- JWT auth scaffolding: return empty plan with summary: "Run: pillar add auth --strategy jwt"
- Project initialization: return empty plan with summary: "Run: pillar init"
You exist for custom logic that these generators cannot produce — business rules, non-standard endpoints, integrations, bug fixes, refactors. Do NOT burn tokens regenerating what the CLI can emit deterministically.

When to use "content":
- For standard CRUD resources (controller, service, repository, model, routes, validator, types, test), do NOT provide "content" — the skeleton engine handles these automatically and produces stack-correct code.
- For non-standard files (health checks, auth utilities, custom middleware, config files, etc.), provide the full file content in "content" because the skeleton engine cannot generate custom logic.

When modifying app.ts, server.ts, or main.ts (route registration files):
- Use "imports" for new import statements to add at the top of the file.
- Use "registrations" for app.use() or similar statements to add in the route registration section.
- Do NOT use "methods" for app/server files — they are not classes.

CRITICAL — every modify action MUST include at least one of: "imports", "registrations", or "methods".
A modify action with only a "purpose" description is INVALID — the executor cannot apply prose as code.

"methods" in a modify action APPENDS new methods to a class — it cannot rewrite an existing method. NEVER reuse a method name that already appears in the file (you can verify from the pass-2 file content). To extend behaviour of an existing method like \`findAll\`, add a NEW method (e.g. \`searchByQuery\`, \`findByName\`) and have the consumer call the new method. Reusing an existing name silently no-ops.

When a method will be called with arguments (e.g. a controller delegating to a service: \`this.svc.search(q)\`), you MUST supply a "signature" on the corresponding service/repository method so arities match. Format: the full parenthesized parameter list + optional return type, e.g. "(q: string): Promise<Product[]>". Without "signature" the executor emits a parameterless stub and the caller will fail to type-check.
If the required change is a new handler, logic block, or endpoint that does not fit the imports/registrations/methods shape,
CREATE a new file with "content" instead (and optionally modify app.ts/main.ts to wire it in via "imports" + "registrations").

Example — adding a /health endpoint:
  create: [{
    "path": "src/features/health/health.routes.ts",
    "purpose": "Health check route",
    "kind": "routes",
    "content": "<full file content here>"
  }]
  modify: [{
    "path": "src/app.ts",
    "purpose": "Wire health routes into the app",
    "kind": "generic",
    "imports": ["import { healthRouter } from './features/health/health.routes.js';"],
    "registrations": ["app.use('/health', healthRouter);"]
  }]`;

/**
 * Build a compact, capped context string from the project map. The cap is
 * the load-bearing optimization that keeps the prompt under ~500 tokens
 * even for large projects. When truncation kicks in we tell the model so
 * it knows the listing is partial and can still ask reasonable questions.
 */
export function buildContext(config: PillarConfig, map: ProjectMap | null): AIRequestContext {
  let mapSummary = 'No project map available — run `pillar map` to generate one.';

  if (map) {
    const lines: string[] = [];
    summarizeNode(map.structure, '', lines);
    if (lines.length > MAX_MAP_LINES) {
      const truncated = lines.length - MAX_MAP_LINES;
      mapSummary = lines.slice(0, MAX_MAP_LINES).join('\n')
        + `\n… (${truncated} more entries omitted for brevity)`;
    } else {
      mapSummary = lines.join('\n');
    }
  }

  return {
    projectName: config.project.name,
    stack: config.project.stack,
    language: config.project.language,
    architecture: config.project.architecture,
    database: config.database.type,
    orm: config.database.orm,
    testFramework: config.generation.testFramework,
    mapSummary,
  };
}

function summarizeNode(nodes: Record<string, unknown>, prefix: string, lines: string[]): void {
  for (const [name, nodeRaw] of Object.entries(nodes)) {
    const node = nodeRaw as { purpose?: string; children?: Record<string, unknown> };
    const here = prefix ? `${prefix}/${name}` : name;
    const isDir = node.children !== undefined;

    if (node.purpose) {
      lines.push(`${here}${isDir ? '/' : ''} — ${node.purpose}`);
    }

    if (node.children) {
      summarizeNode(node.children, here, lines);
    }
  }
}

/**
 * Build the user prompt sent to the model. Keep this tightly scoped —
 * everything here is paid for on every call.
 */
export function buildPrompt(context: AIRequestContext, userRequest: string): string {
  return [
    `Project: ${context.projectName}`,
    `Stack: ${context.stack} | Language: ${context.language} | Architecture: ${context.architecture}`,
    `Database: ${context.database} | ORM: ${context.orm} | Test framework: ${context.testFramework}`,
    '',
    `STACK CONSTRAINT — generated code MUST target ${context.stack.toUpperCase()}:`,
    stackHints(context.stack),
    '',
    'Current project structure:',
    context.mapSummary,
    '',
    `User request: ${userRequest}`,
  ].join('\n');
}

/**
 * Per-stack API patterns the model needs to honor. Kept terse — these are
 * paid for on every prompt. Each line is the minimum the model needs to
 * stop hallucinating Express-style code into NestJS / Hono / Next.js.
 */
function stackHints(stack: string): string {
  switch (stack) {
    case 'express':
      return '- Handlers: (req: Request, res: Response) => res.json(...)\n- Routing: const router = Router(); router.get(path, handler); export default router\n- Wiring in app.ts: app.use(prefix, router)';
    case 'fastify':
      return '- Handlers: async (req: FastifyRequest, res: FastifyReply) => res.send(...)\n- Routing: export async function fooRoutes(app: FastifyInstance) { app.get(path, handler); } — register routes INSIDE this function, not at module scope\n- Wiring in app.ts: await app.register(fooRoutes)\n- DO NOT emit a modify action on *.routes.ts using "registrations" — those land at module scope (outside the route function) and break compilation. To add an endpoint, add a NEW method to the controller via "methods" and put a "Manually register `app.get(...)` inside <name>Routes(app)" note in the plan summary.';
    case 'hono':
      return '- Handlers: (c: Context) => c.json(...)\n- Routing: const router = new Hono(); router.get(path, handler); export default router\n- Wiring in app.ts: app.route(prefix, router)';
    case 'nestjs':
      return '- Use NestJS decorators ONLY — never `app.use()` outside of main.ts.\n- Endpoint: @Controller("foo") class FooController { @Get() find() { return ...; } }\n- A new feature = a Module class with @Module({ controllers, providers }) plus the controller/service classes.\n- Do NOT emit `new FooController().method` calls — Nest uses dependency injection.\n- DO NOT emit a modify action targeting *.module.ts (including app.module.ts) — the executor cannot edit @Module decorator arguments safely. Instead, create the new Module file and append to the plan summary: "Manually register <FooModule> in AppModule.imports at src/app.module.ts".\n- If a "signature" uses Nest decorators like @Query, @Body, @Param, @Headers, you MUST add the matching identifier to the modify action\'s "imports" — e.g. \'import { Query } from "@nestjs/common";\'. Decorator usage without the import fails type-check.\n- Closure rule: if any file you CREATE imports another module-local file (e.g. a controller imports its service), you MUST also CREATE that imported file in the same plan. Never ship a controller importing a service you didn\'t include. For a trivial endpoint like /health, inline the logic in the controller instead of splitting it into a separate service.';
    case 'nextjs':
      return '- Routes are filesystem-based: app/<path>/route.ts exports async function GET/POST/PUT/DELETE(req: NextRequest) returning NextResponse.json(...)\n- Do NOT emit Express-style `app.use()` or routers — Next.js App Router has no central app object.\n- Server-only logic goes in route handlers or server actions; do not import node:* modules in code that may run on the edge runtime.';
    default:
      return '- Follow idiomatic patterns for this stack.';
  }
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Provider response — the raw plan object plus token usage as reported by
 * the API. Falls back to a length-based estimate only when the provider
 * doesn't surface a usage block (very rare; mainly older OpenAI models).
 */
export interface ProviderCallResult {
  plan: AIGenerationPlan;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * Call the AI provider and return a validated plan with real usage data.
 *
 * On schema-validation failure (model emitted a structurally broken plan)
 * we re-ask the provider ONCE, appending the validation errors to the
 * prompt so the model can self-correct. Most variance — missing field,
 * wrong type, unknown kind — resolves on the retry. Token cost of the
 * retry is explicit in the returned usage so the caller can surface it.
 */
export async function callAIProvider(
  providerConfig: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<ProviderCallResult> {
  const first = await callAndValidate(providerConfig, systemPrompt, userPrompt);
  if (first.kind === 'ok') {
    return { plan: first.plan, usage: first.usage };
  }

  // Retry once with the validation errors attached. The model has enough
  // signal to fix the specific structural issue without re-deriving the
  // plan from scratch.
  const correctionPrompt = [
    userPrompt,
    '',
    'Your previous response failed schema validation with these errors:',
    first.issues,
    '',
    'Return a NEW valid JSON plan that fixes these issues. Do not include any prose.',
  ].join('\n');

  const second = await callAndValidate(providerConfig, systemPrompt, correctionPrompt);
  if (second.kind === 'ok') {
    return {
      plan: second.plan,
      usage: {
        inputTokens: first.usage.inputTokens + second.usage.inputTokens,
        outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      },
    };
  }
  throw new Error(`AI plan validation failed (after 1 retry): ${second.issues}`);
}

type ValidationOutcome =
  | { kind: 'ok'; plan: AIGenerationPlan; usage: { inputTokens: number; outputTokens: number } }
  | { kind: 'err'; issues: string; usage: { inputTokens: number; outputTokens: number } };

async function callAndValidate(
  providerConfig: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<ValidationOutcome> {
  const { provider, apiKey, model } = providerConfig;
  const raw = provider === 'anthropic'
    ? await callAnthropic(apiKey, model, systemPrompt, userPrompt)
    : await callOpenAI(apiKey, model, systemPrompt, userPrompt);

  const parsed: unknown = typeof raw.payload === 'string'
    ? parseAIJson(raw.payload)
    : raw.payload;

  const result = aiGenerationPlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    return { kind: 'err', issues, usage: raw.usage };
  }
  return { kind: 'ok', plan: result.data as AIGenerationPlan, usage: raw.usage };
}

export interface FileContextResult {
  plan: AIGenerationPlan;
  /** Real input + output tokens summed across both passes. */
  totalTokens: number;
  /** Per-pass breakdown for cost telemetry. */
  passes: number;
  /** Files referenced by the plan but not re-read because the budget was hit. */
  truncatedFiles: string[];
}

/**
 * Two-pass AI generation:
 *   Pass 1: map context → initial plan (identifies affected files).
 *   Pass 2: read those files, enrich the prompt, refine the plan.
 *
 * Falls back to single-pass when the plan has no `modify` actions or none
 * of the targeted files exist on disk. Files that don't fit the budget are
 * reported as `truncatedFiles` so the command layer can warn the user.
 */
export async function callAIWithFileContext(
  projectRoot: string,
  providerConfig: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<FileContextResult> {
  const pass1 = await callAIProvider(providerConfig, systemPrompt, userPrompt);

  const candidates = pass1.plan.modify
    .map((a) => a.path)
    .filter((p) => !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]:[\\/]/.test(p));

  if (candidates.length === 0) {
    return {
      plan: pass1.plan,
      totalTokens: pass1.usage.inputTokens + pass1.usage.outputTokens,
      passes: 1,
      truncatedFiles: [],
    };
  }

  const fileContents: Array<{ path: string; content: string }> = [];
  const truncatedFiles: string[] = [];
  let totalBytes = 0;

  for (const filePath of candidates) {
    const fullPath = path.join(projectRoot, filePath);
    if (!await fs.pathExists(fullPath)) continue;

    const content = await fs.readFile(fullPath, 'utf-8');
    if (totalBytes + content.length > MAX_PASS2_BYTES) {
      truncatedFiles.push(filePath);
      continue;
    }
    fileContents.push({ path: filePath, content });
    totalBytes += content.length;
  }

  if (fileContents.length === 0) {
    return {
      plan: pass1.plan,
      totalTokens: pass1.usage.inputTokens + pass1.usage.outputTokens,
      passes: 1,
      truncatedFiles,
    };
  }

  const fileContext = fileContents
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const enrichedPrompt = [
    userPrompt,
    '',
    'The following existing files will be modified. Use their actual content to generate accurate modifications.',
    'CRITICAL: match every type name, class name, imported symbol, and existing method signature EXACTLY as it appears below. Do not singularize, pluralize, or rename identifiers — if the file exports `Products`, your signatures must use `Products`, not `Product`.',
    '',
    fileContext,
  ].join('\n');

  const pass2 = await callAIProvider(providerConfig, systemPrompt, enrichedPrompt);

  return {
    plan: pass2.plan,
    totalTokens:
      pass1.usage.inputTokens + pass1.usage.outputTokens
      + pass2.usage.inputTokens + pass2.usage.outputTokens,
    passes: 2,
    truncatedFiles,
  };
}

/**
 * Wraps `fetch` with a hard timeout and bounded retry-with-backoff for
 * transient failures (429, 5xx, abort, network drop). Non-retryable
 * statuses (4xx other than 429) bubble immediately so the operator sees
 * actionable errors (bad API key, malformed body) without delay.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);

      // Retry-eligible: 429 and 5xx. We must consume the body to free the
      // socket — and once consumed, the Response can't be returned as-is
      // (the caller's body read would fail). On exhaustion we throw a
      // structured error carrying the status + body so the caller sees a
      // clean message instead of a confusing "body already used" crash.
      if (response.status === 429 || response.status >= 500) {
        const body = await response.text();
        const truncated = body.length > 200 ? `${body.slice(0, 200)}…` : body;
        lastError = new Error(`${label} API error (${response.status}): ${truncated}`);
        if (attempt < RETRY_MAX_ATTEMPTS) {
          const retryAfter = parseRetryAfterMs(response.headers.get('retry-after'));
          const backoff = retryAfter ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
          const jitter = Math.floor(Math.random() * 250);
          await sleep(backoff + jitter);
          continue;
        }
        throw lastError;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      const error = err as Error & { name?: string };
      // AbortError (timeout) and TypeError (network failure) are retryable.
      const retryable = error.name === 'AbortError' || error.name === 'TypeError';
      lastError = error.name === 'AbortError'
        ? new Error(`${label} request timed out after ${REQUEST_TIMEOUT_MS}ms`)
        : error;
      if (!retryable || attempt === RETRY_MAX_ATTEMPTS) throw lastError;
      const backoff = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await sleep(backoff + Math.floor(Math.random() * 250));
    }
  }

  throw lastError ?? new Error(`${label}: exhausted retries`);
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds, 30) * 1000;
  // HTTP date form — convert to delta. Cap at 30s so we don't sleep forever.
  const ts = Date.parse(header);
  if (Number.isFinite(ts)) return Math.min(Math.max(ts - Date.now(), 0), 30_000);
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface RawProviderResponse {
  payload: string | unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/**
 * OpenAI Chat Completions with structured outputs (`json_schema`). This
 * gives us schema-level guarantees that the response shape matches the
 * plan — closing the parity gap with Anthropic tool-use.
 *
 * `usage` is read from the API response so token reporting matches billing.
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<RawProviderResponse> {
  const response = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'pillar_plan',
          strict: false, // permissive: tolerate unknown fields, refs in $defs
          schema: PLAN_TOOL_SCHEMA,
        },
      },
    }),
  }, 'OpenAI');

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');

  return {
    payload: content,
    usage: {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * Anthropic Messages with forced tool-use. We advertise a single tool
 * matching the plan shape and force `tool_choice` — this turns the
 * response into a pre-parsed JSON object rather than free-form text,
 * eliminating the "stray thinking token breaks JSON.parse" failure mode.
 *
 * The system prompt is marked `cache_control: ephemeral` so pass 2 in the
 * two-pass flow only pays for the user delta, not the full system prompt
 * again. Cache TTL is ~5 minutes — well within typical CLI session times.
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<RawProviderResponse> {
  const response = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      system: [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
      ],
      tools: [
        {
          name: 'emit_plan',
          description: 'Emit the structured file-generation plan for the user request.',
          input_schema: PLAN_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_plan' },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  }, 'Anthropic');

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<
      | { type: 'tool_use'; name: string; input: unknown }
      | { type: 'text'; text: string }
      | { type: string; [k: string]: unknown }
    >;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };

  const usage = {
    inputTokens:
      (data.usage?.input_tokens ?? 0)
      + (data.usage?.cache_creation_input_tokens ?? 0)
      + (data.usage?.cache_read_input_tokens ?? 0),
    outputTokens: data.usage?.output_tokens ?? 0,
  };

  for (const block of data.content) {
    if (block.type === 'tool_use' && (block as { name: string }).name === 'emit_plan') {
      return { payload: (block as { input: unknown }).input, usage };
    }
  }

  // Fallback: concatenate text blocks if the model bypassed tool-use.
  const text = data.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) throw new Error('Empty response from Anthropic');
  return { payload: text, usage };
}

export { AIResponseParseError };
