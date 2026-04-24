export { selectAdapter } from './adapter-factory.js';
export { runCommand, packageManagerExec } from './runner.js';
export { MigrationError, isUnsupported, UNSUPPORTED } from './types.js';
export type {
  MigrationAdapter,
  CommandPlan,
  PlanResult,
  RunContext,
  RunResult,
  GenerateOpts,
  MigrateOpts,
  Unsupported,
} from './types.js';
