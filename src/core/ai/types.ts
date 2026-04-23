import type { PlanFileKind } from './plan-schema.js';

export interface AIGenerationPlan {
  create: AIFileAction[];
  modify: AIFileAction[];
  summary: string;
}

export interface AIFileAction {
  path: string;
  purpose: string;
  kind: PlanFileKind;
  fields?: Array<{ name: string; type: string }>;
  methods?: Array<{ name: string; description: string }>;
  content?: string;
  imports?: string[];
  registrations?: string[];
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
  testFramework: string;
  mapSummary: string;
}
