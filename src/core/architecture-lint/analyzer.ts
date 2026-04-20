/**
 * Architecture lint — static checks that enforce the architectural pattern
 * selected at `pillar init` time. These rules are deliberately stricter than
 * ESLint defaults: they encode Pillar's opinions about feature isolation,
 * layer discipline, and database-driver containment.
 *
 * Rules:
 *   AL001  controller → repository     Controllers must not access the
 *                                       data layer directly; go through a
 *                                       service.
 *   AL002  repository → service         Repositories are a lower layer than
 *                                       services; the import direction is
 *                                       inverted.
 *   AL003  cross-feature import         (feature-first only) Feature A
 *                                       imports from feature B. Extract to
 *                                       `src/shared/`.
 *   AL004  cross-module import          (modular only) Module A imports
 *                                       from module B. Extract to
 *                                       `src/common/`.
 *   AL005  db driver outside repo/model Only repositories and models may
 *                                       import raw database drivers.
 *   AL006  circular dependency          Two or more files form a cycle.
 *
 * All rules return file-anchored violations with `line` + `column` pulled
 * from the ts-morph AST so editors can jump straight to them.
 */

import path from 'node:path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { Project, type SourceFile, type ImportDeclaration } from 'ts-morph';
import type { PillarConfig } from '../config/index.js';
import { inferFileKind } from '../generator/skeleton.js';
import type { FileKind } from '../generator/types.js';

export type Severity = 'error' | 'warn';

export interface Violation {
  /** Stable rule code, e.g. `AL001`. */
  rule: string;
  severity: Severity;
  /** Project-relative file path. */
  file: string;
  line?: number;
  column?: number;
  message: string;
  hint?: string;
}

export interface AnalysisReport {
  violations: Violation[];
  filesScanned: number;
  rulesApplied: string[];
}

/** Database driver modules that may only appear inside repository/model files. */
const DB_DRIVER_MODULES: ReadonlySet<string> = new Set([
  'pg', 'postgres', 'mongodb', 'mongoose', 'better-sqlite3',
  '@prisma/client', 'prisma', 'drizzle-orm', 'typeorm',
  // Drizzle sub-paths (`drizzle-orm/node-postgres`, etc.) are covered via
  // prefix match below — do not list every variant here.
]);

const DB_DRIVER_PREFIXES: readonly string[] = ['drizzle-orm/', 'typeorm/'];

/** File kinds allowed to import DB drivers. */
const DB_ALLOWED_KINDS: ReadonlySet<FileKind> = new Set(['repository', 'model']);

interface FileRecord {
  absPath: string;
  relPath: string;
  kind: FileKind;
  feature: string | null;
  module: string | null;
  source: SourceFile;
  /** Resolved import edges: absolute paths to other files in the project. */
  localImports: Array<{ target: string; spec: string; line: number; column: number }>;
  /** Bare specifiers (node_modules imports). */
  externalImports: Array<{ spec: string; line: number; column: number }>;
}

export async function analyzeArchitecture(
  projectRoot: string,
  config: PillarConfig,
): Promise<AnalysisReport> {
  const srcRoot = path.join(projectRoot, 'src');
  if (!(await fs.pathExists(srcRoot))) {
    return { violations: [], filesScanned: 0, rulesApplied: [] };
  }

  // Enumerate eligible source files. Tests and type-only declaration files
  // are excluded because they intentionally reach across architectural
  // boundaries (integration tests import controllers + repositories + etc).
  const patterns = ['**/*.ts', '**/*.tsx'];
  const ignore = ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx', '**/*.d.ts'];
  const filesAbs: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: srcRoot, ignore, absolute: true, nodir: true });
    filesAbs.push(...matches);
  }

  // Build a single in-memory ts-morph Project for the whole analysis so
  // import resolution is consistent and we pay parse cost once per file.
  const project = new Project({
    compilerOptions: {
      allowJs: false,
      moduleResolution: 2 /* Node */,
      baseUrl: projectRoot,
    },
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  const records: FileRecord[] = [];
  const recordByAbs = new Map<string, FileRecord>();

  for (const abs of filesAbs) {
    const content = await fs.readFile(abs, 'utf-8');
    const sf = project.createSourceFile(abs, content, { overwrite: true });
    const relPath = path.relative(projectRoot, abs);
    const kind = inferFileKind(path.basename(abs));
    const feature = extractFeature(relPath);
    const module = extractModule(relPath);

    const rec: FileRecord = {
      absPath: abs,
      relPath,
      kind,
      feature,
      module,
      source: sf,
      localImports: [],
      externalImports: [],
    };
    records.push(rec);
    recordByAbs.set(abs, rec);
  }

  // Resolve import edges. A spec that starts with `.` or `..` is treated as
  // a local file; anything else is external. `.js` suffix is stripped when
  // looking up the peer file because ESM-style imports use it.
  for (const rec of records) {
    for (const decl of rec.source.getImportDeclarations()) {
      const spec = decl.getModuleSpecifierValue();
      const { line, column } = positionOf(decl);
      if (isRelativeSpec(spec)) {
        const resolved = resolveLocalImport(rec.absPath, spec, recordByAbs);
        if (resolved) {
          rec.localImports.push({ target: resolved, spec, line, column });
        }
      } else {
        rec.externalImports.push({ spec, line, column });
      }
    }
  }

  const violations: Violation[] = [];
  const rulesApplied: string[] = [];

  rulesApplied.push('AL001', 'AL002');
  for (const rec of records) {
    for (const edge of rec.localImports) {
      const target = recordByAbs.get(edge.target);
      if (!target) continue;

      // AL001: controller → repository direct access.
      if (rec.kind === 'controller' && target.kind === 'repository') {
        violations.push({
          rule: 'AL001',
          severity: 'error',
          file: rec.relPath,
          line: edge.line,
          column: edge.column,
          message: `Controller imports repository "${target.relPath}" directly.`,
          hint: 'Route data access through a service to keep HTTP concerns separate from persistence.',
        });
      }

      // AL002: repository → service (wrong layer direction).
      if (rec.kind === 'repository' && target.kind === 'service') {
        violations.push({
          rule: 'AL002',
          severity: 'error',
          file: rec.relPath,
          line: edge.line,
          column: edge.column,
          message: `Repository imports service "${target.relPath}".`,
          hint: 'Services depend on repositories, not the other way around. Invert the dependency.',
        });
      }
    }
  }

  // AL003: feature-first cross-feature imports.
  if (config.project.architecture === 'feature-first') {
    rulesApplied.push('AL003');
    for (const rec of records) {
      if (!rec.feature) continue;
      for (const edge of rec.localImports) {
        const target = recordByAbs.get(edge.target);
        if (!target?.feature) continue;
        if (target.feature !== rec.feature) {
          violations.push({
            rule: 'AL003',
            severity: 'error',
            file: rec.relPath,
            line: edge.line,
            column: edge.column,
            message: `Feature "${rec.feature}" imports from feature "${target.feature}".`,
            hint: 'Extract the shared logic to src/shared/ or wire the two features via an explicit contract.',
          });
        }
      }
    }
  }

  // AL004: modular cross-module imports.
  if (config.project.architecture === 'modular') {
    rulesApplied.push('AL004');
    for (const rec of records) {
      if (!rec.module) continue;
      for (const edge of rec.localImports) {
        const target = recordByAbs.get(edge.target);
        if (!target?.module) continue;
        if (target.module !== rec.module) {
          violations.push({
            rule: 'AL004',
            severity: 'error',
            file: rec.relPath,
            line: edge.line,
            column: edge.column,
            message: `Module "${rec.module}" imports from module "${target.module}".`,
            hint: 'Move shared code into src/common/ or expose it through an explicit module interface.',
          });
        }
      }
    }
  }

  // AL005: DB drivers outside repository/model.
  rulesApplied.push('AL005');
  for (const rec of records) {
    if (DB_ALLOWED_KINDS.has(rec.kind)) continue;
    for (const imp of rec.externalImports) {
      if (!isDbDriver(imp.spec)) continue;
      violations.push({
        rule: 'AL005',
        severity: 'error',
        file: rec.relPath,
        line: imp.line,
        column: imp.column,
        message: `${rec.kind} file imports database driver "${imp.spec}".`,
        hint: 'Confine database access to repository and model files so swapping the driver only touches those layers.',
      });
    }
  }

  // AL006: circular dependencies.
  rulesApplied.push('AL006');
  const cycles = findCycles(records);
  for (const cycle of cycles) {
    const files = cycle.map((r) => r.relPath);
    violations.push({
      rule: 'AL006',
      severity: 'warn',
      file: files[0]!,
      message: `Circular import: ${files.join(' → ')} → ${files[0]}.`,
      hint: 'Break the cycle by introducing an interface at the shared boundary or moving the common type to a leaf module.',
    });
  }

  return {
    violations,
    filesScanned: records.length,
    rulesApplied,
  };
}

// --- helpers ---

function isRelativeSpec(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

function isDbDriver(spec: string): boolean {
  if (DB_DRIVER_MODULES.has(spec)) return true;
  return DB_DRIVER_PREFIXES.some((p) => spec.startsWith(p));
}

function positionOf(decl: ImportDeclaration): { line: number; column: number } {
  const sf = decl.getSourceFile();
  const start = decl.getStart();
  const lineAndChar = sf.getLineAndColumnAtPos(start);
  return { line: lineAndChar.line, column: lineAndChar.column };
}

function extractFeature(relPath: string): string | null {
  const m = relPath.match(/^src\/features\/([^/\\]+)\//);
  return m ? m[1]! : null;
}

function extractModule(relPath: string): string | null {
  const m = relPath.match(/^src\/modules\/([^/\\]+)\//);
  return m ? m[1]! : null;
}

/**
 * Resolve an ESM import specifier (`./foo.service.js`, `../bar/baz.js`) to
 * an absolute path on disk. Tries `.ts`, `.tsx`, and `.js` → `.ts`
 * substitution because the generated projects write `.js` suffixes even
 * though the source files are `.ts`.
 */
function resolveLocalImport(
  fromAbs: string,
  spec: string,
  recordByAbs: Map<string, FileRecord>,
): string | null {
  const base = path.resolve(path.dirname(fromAbs), spec);

  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.jsx$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];

  for (const c of candidates) {
    if (recordByAbs.has(c)) return c;
  }
  return null;
}

/**
 * Find strongly connected components with more than one node, or a single
 * node that imports itself. Returns each cycle as an ordered list of the
 * nodes that participate in it.
 *
 * We use an iterative Tarjan's SCC rather than DFS-recursion to avoid stack
 * overflow on large generated projects.
 */
function findCycles(records: FileRecord[]): FileRecord[][] {
  const indexMap = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: FileRecord[] = [];
  const cycles: FileRecord[][] = [];
  let index = 0;

  const byAbs = new Map(records.map((r) => [r.absPath, r] as const));

  function strongconnect(v: FileRecord): void {
    // Iterative Tarjan using an explicit work stack.
    const work: Array<{ node: FileRecord; neighbors: string[]; i: number }> = [];
    indexMap.set(v.absPath, index);
    lowlink.set(v.absPath, index);
    index++;
    stack.push(v);
    onStack.add(v.absPath);
    work.push({ node: v, neighbors: v.localImports.map((e) => e.target), i: 0 });

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      if (frame.i < frame.neighbors.length) {
        const wAbs = frame.neighbors[frame.i++]!;
        const w = byAbs.get(wAbs);
        if (!w) continue;
        if (!indexMap.has(w.absPath)) {
          indexMap.set(w.absPath, index);
          lowlink.set(w.absPath, index);
          index++;
          stack.push(w);
          onStack.add(w.absPath);
          work.push({ node: w, neighbors: w.localImports.map((e) => e.target), i: 0 });
        } else if (onStack.has(w.absPath)) {
          lowlink.set(frame.node.absPath, Math.min(lowlink.get(frame.node.absPath)!, indexMap.get(w.absPath)!));
        }
      } else {
        // Done with this node — pop.
        work.pop();
        const parent = work[work.length - 1];
        if (parent) {
          parent.node.absPath;
          lowlink.set(parent.node.absPath, Math.min(lowlink.get(parent.node.absPath)!, lowlink.get(frame.node.absPath)!));
        }
        if (lowlink.get(frame.node.absPath) === indexMap.get(frame.node.absPath)) {
          const scc: FileRecord[] = [];
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w.absPath);
            scc.push(w);
            if (w.absPath === frame.node.absPath) break;
          }
          if (scc.length > 1) {
            cycles.push(scc.reverse());
          } else if (scc.length === 1) {
            // Self-loop detection.
            const only = scc[0]!;
            if (only.localImports.some((e) => e.target === only.absPath)) {
              cycles.push(scc);
            }
          }
        }
      }
    }
  }

  for (const r of records) {
    if (!indexMap.has(r.absPath)) strongconnect(r);
  }

  return cycles;
}
