import type { PillarConfig } from '../config/index.js';
import type { ProjectMap } from '../map/types.js';
import type { AIGenerationPlan, AIRequestContext, AIProviderConfig } from './types.js';

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

  let responseText: string;

  if (provider === 'anthropic') {
    responseText = await callAnthropic(apiKey, model, systemPrompt, userPrompt);
  } else {
    responseText = await callOpenAI(apiKey, model, systemPrompt, userPrompt);
  }

  // Parse the JSON response
  const cleaned = responseText
    .replace(/^```json?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim();

  const plan = JSON.parse(cleaned) as AIGenerationPlan;

  // Validate the plan structure
  if (!plan.summary || !Array.isArray(plan.create) || !Array.isArray(plan.modify)) {
    throw new Error('AI response did not match expected plan schema');
  }

  return plan;
}

export function getSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

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

async function callAnthropic(
  apiKey: string,
  model: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  const textBlock = data.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Empty response from Anthropic');
  return textBlock.text;
}
