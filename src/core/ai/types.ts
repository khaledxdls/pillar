export interface AIGenerationPlan {
  create: AIFileAction[];
  modify: AIFileAction[];
  summary: string;
}

export interface AIFileAction {
  path: string;
  purpose: string;
  kind: string;
  fields?: Array<{ name: string; type: string }>;
  methods?: Array<{ name: string; description: string }>;
}

export interface AIProviderConfig {
  provider: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
}

export interface AIRequestContext {
  projectName: string;
  stack: string;
  language: string;
  architecture: string;
  database: string;
  orm: string;
  mapSummary: string;
}
