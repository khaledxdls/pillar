// Public API for programmatic usage
export { loadConfig, writeConfig, getConfigValue, setConfigValue } from './core/config/index.js';
export type { PillarConfig } from './core/config/index.js';

export { MapManager } from './core/map/index.js';
export type { ProjectMap, MapNode } from './core/map/index.js';

export { HistoryManager } from './core/history/index.js';
export type { HistoryEntry, FileOperation } from './core/history/index.js';

export { ResourceGenerator, scaffoldProject, generateSkeleton } from './core/generator/index.js';
export type { GeneratedFile, ResourceField } from './core/generator/index.js';

export { runDiagnostics } from './core/doctor/index.js';
export type { DiagnosticReport, DiagnosticCheck } from './core/doctor/index.js';
