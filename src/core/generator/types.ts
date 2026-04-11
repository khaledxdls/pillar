import type { Stack, Language, Architecture, Database, Orm, TestFramework } from '../../utils/constants.js';

export interface GeneratorContext {
  projectName: string;
  stack: Stack;
  language: Language;
  architecture: Architecture;
  database: Database;
  orm: Orm;
  testFramework: TestFramework;
}

export interface ResourceField {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  default?: string;
}

export interface GeneratedFile {
  relativePath: string;
  content: string;
  purpose: string;
}

export type FileKind =
  | 'controller'
  | 'service'
  | 'repository'
  | 'model'
  | 'routes'
  | 'validator'
  | 'types'
  | 'test'
  | 'component'
  | 'middleware'
  | 'util'
  | 'generic';
