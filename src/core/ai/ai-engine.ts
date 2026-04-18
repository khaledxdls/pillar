import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { ProjectMap } from '../map/types.js';
import type { AIGenerationPlan, AIRequestContext, AIProviderConfig } from './types.js';
import { aiGenerationPlanSchema } from './plan-schema.js';
import { parseAIJson, AIResponseParseError } from './json-parser.js';

/** Current Anthropic API version. Bumped from `2023-06-01` (pre tool-use). */
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * Default models. Kept in one place so CLI flags, docs, and the engine stay
 * aligned. These are the generally-available, non-legacy model IDs at the
 * time of writing; users can always override with `--model`.
 */
export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
} as const;

/**
 * JSON Schema for the AI plan, used by Anthropic tool-use to force
 * structured output. Mirrors `aiGenerationPlanSchema` (Zod) — keep in sync.
 * The schema is intentionally permissive around unknown fields so we don't
 * reject valid plans when the model adds harmless extras.
 */
const PLAN_TOOL_SCHEMA = {
  type: 'object',
  required: ['summary', 'create', 'modify'],
  properties: {
    summary: { type: 'string' },
    create: { type: 'array', items: { $ref: '#/definitions/fileAction' } },
    modify: { type: 'array', items: { $ref: '#/definitions/fileAction' } },
  },
  definitions: {
    fileAction: {
      type: 'object',
      required: ['path', 'purpose', 'kind'],
      properties: {
        path: { type: 'string' },
        purpose: { type: 'string' },
        kind: { type: 'string' },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'type'],
            properties: { name: { type: 'string' }, type: { type: 'string' } },
          },
        },
        methods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name', 'description'],
            properties: { name: { type: 'string' }, description: { type: 'string' } },
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
      "kind": "controller|service|repository|model|routes|validator|types|test|middleware|util|generic",
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
      "methods": [{"name": "newMethodName", "description": "what it does"}],
      "imports": ["import { fooRouter } from './foo.routes.js';"],
      "registrations": ["app.use('/foo', fooRouter);"]
    }
  ]
}

Rules:
- Only return JSON. No markdown, no code blocks, no explanation.
- File paths must follow the project's architecture pattern.
- Use the project map to understand what already exists.
- Minimize changes — only create/modify what's needed.
- Every file must have a purpose.

When to use "content":
- For standard CRUD resources (controller, service, repository, model, routes, validator, types, test), do NOT provide "content" — the skeleton engine handles these automatically.
- For non-standard files (health checks, auth utilities, custom middleware, config files, etc.), provide the full file content in "content" because the skeleton engine cannot generate custom logic.

When modifying app.ts or server.ts (route registration files):
- Use "imports" for new import statements to add at the top of the file.
- Use "registrations" for app.use() or similar statements to add in the route registration section.
- Do NOT use "methods" for app/server files — they are not classes.`;

/**
 * Build the minimal context string from the project map.
 * This is the key cost optimization — we send ~500 tokens instead of the full codebase.
 */
export function buildContext(config: PillarConfig, map: ProjectMap | null): AIRequestContext {
  let mapSummary = 'No project map available.';

  if (map) {
    const lines: string[] = [];
    summarizeNode(map.structure, '', lines);
    mapSummary = lines.join('\n');
  }

  return {
    projectName: config.project.name,
    stack: config.project.stack,
    language: config.project.language,
    architecture: config.project.architecture,
    database: config.database.type,
    orm: config.database.orm,
    mapSummary,
  };
}

function summarizeNode(nodes: Record<string, unknown>, prefix: string, lines: string[]): void {
  for (const [name, nodeRaw] of Object.entries(nodes)) {
    const node = nodeRaw as { purpose?: string; children?: Record<string, unknown> };
    const path = prefix ? `${prefix}/${name}` : name;
    const isDir = node.children !== undefined;

    if (node.purpose) {
      lines.push(`${path}${isDir ? '/' : ''} — ${node.purpose}`);
    }

    if (node.children) {
      summarizeNode(node.children, path, lines);
    }
  }
}

/**
 * Build the full prompt for the AI provider.
 */
export function buildPrompt(context: AIRequestContext, userRequest: string): string {
  return [
    `Project: ${context.projectName}`,
    `Stack: ${context.stack} | Language: ${context.language} | Architecture: ${context.architecture}`,
    `Database: ${context.database} | ORM: ${context.orm}`,
    '',
    'Current project structure:',
    context.mapSummary,
    '',
    `User request: ${userRequest}`,
  ].join('\n');
}

/**
 * Call the AI provider API and return a generation plan.
 * Supports OpenAI and Anthropic APIs.
 */
export async function callAIProvider(
  providerConfig: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<AIGenerationPlan> {
  const { provider, apiKey, model } = providerConfig;

  // Providers now return either a pre-parsed object (tool_use /
  // response_format=json_object) or raw text. The tolerant parser absorbs
  // the variance without a special case per provider.
  const rawResponse = provider === 'anthropic'
    ? await callAnthropic(apiKey, model, systemPrompt, userPrompt)
    : await callOpenAI(apiKey, model, systemPrompt, userPrompt);

  const parsed: unknown = typeof rawResponse === 'string'
    ? parseAIJson(rawResponse)
    : rawResponse;

  const result = aiGenerationPlanSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`AI plan validation failed: ${issues}`);
  }

  return result.data as AIGenerationPlan;
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

/**
 * Two-pass AI generation:
 *   Pass 1: Send map context → get initial plan (identifies affected files).
 *   Pass 2: Read those files from disk, enrich the prompt, refine the plan.
 *
 * Falls back to single-pass if no files need modification or if the files don't exist.
 */
export async function callAIWithFileContext(
  projectRoot: string,
  providerConfig: AIProviderConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ plan: AIGenerationPlan; totalTokens: number }> {
  // Pass 1: initial plan from map context
  const initialPlan = await callAIProvider(providerConfig, systemPrompt, userPrompt);
  const pass1Tokens = Math.ceil((systemPrompt.length + userPrompt.length) / 4);

  // Collect files that need modification
  const filesToRead = initialPlan.modify
    .map((a) => a.path)
    .filter((p) => !p.startsWith('/') && !p.includes('..'));

  if (filesToRead.length === 0) {
    return { plan: initialPlan, totalTokens: pass1Tokens };
  }

  // Read affected files (cap total at ~8KB to keep tokens reasonable)
  const fileContents: Array<{ path: string; content: string }> = [];
  let totalBytes = 0;
  const MAX_BYTES = 8192;

  for (const filePath of filesToRead) {
    const fullPath = path.join(projectRoot, filePath);
    if (!await fs.pathExists(fullPath)) continue;

    const content = await fs.readFile(fullPath, 'utf-8');
    if (totalBytes + content.length > MAX_BYTES) break;
    fileContents.push({ path: filePath, content });
    totalBytes += content.length;
  }

  if (fileContents.length === 0) {
    return { plan: initialPlan, totalTokens: pass1Tokens };
  }

  // Pass 2: enriched prompt with file contents
  const fileContext = fileContents
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');

  const enrichedPrompt = [
    userPrompt,
    '',
    'The following existing files will be modified. Use their actual content to generate accurate modifications:',
    '',
    fileContext,
  ].join('\n');

  const refinedPlan = await callAIProvider(providerConfig, systemPrompt, enrichedPrompt);
  const pass2Tokens = Math.ceil((systemPrompt.length + enrichedPrompt.length) / 4);

  return { plan: refinedPlan, totalTokens: pass1Tokens + pass2Tokens };
}

/**
 * OpenAI Chat Completions with `response_format: json_object`. Returns the
 * raw string content; the caller runs it through the tolerant parser.
 */
async function callOpenAI(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices[0]?.message?.content;
  if (!content) throw new Error('Empty response from OpenAI');
  return content;
}

/**
 * Anthropic Messages with forced tool-use. We advertise a single tool whose
 * schema matches the plan shape and set `tool_choice` to that tool — this
 * turns the response into a pre-parsed JSON object rather than free-form
 * text, eliminating the "stray thinking token breaks JSON.parse" failure
 * mode. If for some reason tool_use isn't returned, we fall back to
 * concatenated text blocks and let the tolerant parser handle them.
 */
async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<unknown> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
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
      system: systemPrompt,
      tools: [
        {
          name: 'emit_plan',
          description:
            'Emit the structured file-generation plan for the user request.',
          input_schema: PLAN_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: 'emit_plan' },
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

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
  };

  for (const block of data.content) {
    if (block.type === 'tool_use' && (block as { name: string }).name === 'emit_plan') {
      return (block as { input: unknown }).input;
    }
  }

  // Fallback: concatenate text blocks if the model bypassed tool-use.
  const text = data.content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  if (!text) throw new Error('Empty response from Anthropic');
  return text;
}

export { AIResponseParseError };
