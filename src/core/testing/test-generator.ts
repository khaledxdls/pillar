import path from 'node:path';
import fs from 'fs-extra';
import type { PillarConfig } from '../config/index.js';
import type { MapNode } from '../map/types.js';
import { MapManager } from '../map/index.js';
import { inferFileKind } from '../generator/skeleton.js';
import type { GeneratedFile } from '../generator/types.js';

interface TestGenContext {
  projectRoot: string;
  config: PillarConfig;
  testFramework: string;
}

/**
 * Generate test files for a given path (file or directory).
 * Uses the project map to understand file purposes and dependencies.
 */
export async function generateTestsForPath(
  ctx: TestGenContext,
  targetPath: string,
): Promise<GeneratedFile[]> {
  const { projectRoot, config } = ctx;
  const fullPath = path.join(projectRoot, targetPath);
  const isDir = (await fs.stat(fullPath).catch(() => null))?.isDirectory() ?? false;

  if (isDir) {
    return generateTestsForDirectory(ctx, targetPath);
  }
  return generateTestForFile(ctx, targetPath);
}

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', '.git', '.pillar', 'coverage']);

/**
 * Recursively walk a directory, generating test stubs for every eligible
 * source file. Required so that feature-first layouts (one folder holds
 * controller + service + repository) and layered layouts (each kind lives
 * under its own sibling dir) both produce full coverage from a single
 * `pillar test generate <path>` call.
 */
async function generateTestsForDirectory(
  ctx: TestGenContext,
  dirPath: string,
): Promise<GeneratedFile[]> {
  const { projectRoot } = ctx;
  const fullDir = path.join(projectRoot, dirPath);
  const entries = await fs.readdir(fullDir, { withFileTypes: true });
  const results: GeneratedFile[] = [];

  for (const entry of entries) {
    const childRel = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const nested = await generateTestsForDirectory(ctx, childRel);
      results.push(...nested);
      continue;
    }

    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name);
    if (!['.ts', '.tsx', '.js', '.jsx'].includes(ext)) continue;
    if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;

    const tests = await generateTestForFile(ctx, childRel);
    results.push(...tests);
  }

  return results;
}

async function generateTestForFile(
  ctx: TestGenContext,
  filePath: string,
): Promise<GeneratedFile[]> {
  const { projectRoot, config } = ctx;
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const dirName = path.dirname(filePath);
  const testFileName = `${baseName}.test${ext}`;
  const testFilePath = path.join(dirName, testFileName);

  // Skip if test already exists
  if (await fs.pathExists(path.join(projectRoot, testFilePath))) {
    return [];
  }

  // Read the source file to understand its exports
  const fullPath = path.join(projectRoot, filePath);
  if (!(await fs.pathExists(fullPath))) return [];

  const sourceContent = await fs.readFile(fullPath, 'utf-8');
  const exports = extractExports(sourceContent);
  const kind = inferFileKind(path.basename(filePath));

  // Get purpose from the map
  const mapManager = new MapManager(projectRoot);
  const map = await mapManager.load();
  const purpose = findPurposeInMap(map?.structure ?? {}, filePath);

  const framework = config.generation.testFramework;
  const importPath = `./${baseName}${ext === '.ts' || ext === '.tsx' ? '.js' : ext}`;

  const content = generateTestContent({
    framework,
    kind,
    baseName,
    exports,
    importPath,
    purpose,
    isTS: ext === '.ts' || ext === '.tsx',
  });

  return [{
    relativePath: testFilePath,
    content,
    purpose: `Tests for ${baseName}: ${purpose || kind}`,
  }];
}

interface TestContentOptions {
  framework: string;
  kind: string;
  baseName: string;
  exports: ExportInfo[];
  importPath: string;
  purpose: string;
  isTS: boolean;
}

function generateTestContent(opts: TestContentOptions): string {
  const { framework, kind, baseName, exports, importPath, purpose, isTS } = opts;
  const lines: string[] = [];

  const pascalName = baseName.charAt(0).toUpperCase() + baseName.slice(1).replace(/[-_.](\w)/g, (_, c: string) => c.toUpperCase());

  // Import statement
  if (framework === 'vitest') {
    lines.push(`import { describe, it, expect, beforeEach } from 'vitest';`);
  }

  if (exports.length > 0) {
    const importNames = exports
      .filter((e) => e.name !== 'default')
      .map((e) => e.name);
    const defaultExport = exports.find((e) => e.name === 'default');

    const parts: string[] = [];
    if (defaultExport) parts.push(pascalName);
    if (importNames.length > 0) parts.push(`{ ${importNames.join(', ')} }`);

    if (parts.length > 0) {
      lines.push(`import ${parts.join(', ')} from '${importPath}';`);
    }
  }

  lines.push('');

  // Test structure based on file kind
  switch (kind) {
    case 'service':
      lines.push(...generateServiceTests(pascalName, exports, isTS, purpose));
      break;
    case 'controller':
      lines.push(...generateControllerTests(pascalName, exports, purpose));
      break;
    case 'repository':
      lines.push(...generateRepositoryTests(pascalName, exports, purpose));
      break;
    case 'middleware':
      lines.push(...generateMiddlewareTests(pascalName, exports, purpose));
      break;
    case 'util':
      lines.push(...generateUtilTests(exports, purpose));
      break;
    default:
      lines.push(...generateGenericTests(pascalName, exports, purpose));
      break;
  }

  lines.push('');
  return lines.join('\n');
}

function generateServiceTests(name: string, exports: ExportInfo[], isTS: boolean, purpose: string): string[] {
  return [
    `describe('${name}', () => {`,
    `  let service${isTS ? `: InstanceType<typeof ${name}>` : ''};`,
    '',
    '  beforeEach(() => {',
    `    service = new ${name}();`,
    '  });',
    '',
    `  it('should be defined', () => {`,
    `    expect(service).toBeDefined();`,
    '  });',
    '',
    '  describe("findAll", () => {',
    '    it("should return an array", async () => {',
    '      // TODO: implement — mock repository, verify service logic',
    '      expect(service.findAll).toBeDefined();',
    '    });',
    '  });',
    '',
    '  describe("findOne", () => {',
    '    it("should return a single item", async () => {',
    '      // TODO: implement',
    '      expect(service.findOne).toBeDefined();',
    '    });',
    '  });',
    '',
    '  describe("create", () => {',
    '    it("should create and return a new item", async () => {',
    '      // TODO: implement',
    '      expect(service.create).toBeDefined();',
    '    });',
    '  });',
    '',
    '  describe("update", () => {',
    '    it("should update and return the item", async () => {',
    '      // TODO: implement',
    '      expect(service.update).toBeDefined();',
    '    });',
    '  });',
    '',
    '  describe("remove", () => {',
    '    it("should remove the item", async () => {',
    '      // TODO: implement',
    '      expect(service.remove).toBeDefined();',
    '    });',
    '  });',
    '});',
  ];
}

function generateControllerTests(name: string, exports: ExportInfo[], purpose: string): string[] {
  return [
    `describe('${name}', () => {`,
    `  let controller: InstanceType<typeof ${name}>;`,
    '',
    '  beforeEach(() => {',
    `    controller = new ${name}();`,
    '  });',
    '',
    '  it("should be defined", () => {',
    '    expect(controller).toBeDefined();',
    '  });',
    '',
    '  describe("findAll", () => {',
    '    it("should handle GET request", async () => {',
    '      // TODO: mock req/res, call controller.findAll, assert response',
    '      expect(controller.findAll).toBeDefined();',
    '    });',
    '  });',
    '',
    '  describe("create", () => {',
    '    it("should handle POST request", async () => {',
    '      // TODO: mock req/res with body, call controller.create',
    '      expect(controller.create).toBeDefined();',
    '    });',
    '  });',
    '});',
  ];
}

function generateRepositoryTests(name: string, exports: ExportInfo[], purpose: string): string[] {
  return [
    `describe('${name}', () => {`,
    `  let repository: InstanceType<typeof ${name}>;`,
    '',
    '  beforeEach(() => {',
    `    repository = new ${name}();`,
    '  });',
    '',
    '  it("should be defined", () => {',
    '    expect(repository).toBeDefined();',
    '  });',
    '',
    '  // TODO: set up test database connection for integration tests',
    '',
    '  describe("findAll", () => {',
    '    it("should query the database", async () => {',
    '      // TODO: implement with test database',
    '      expect(repository.findAll).toBeDefined();',
    '    });',
    '  });',
    '});',
  ];
}

function generateMiddlewareTests(name: string, exports: ExportInfo[], purpose: string): string[] {
  const funcExports = exports.filter((e) => e.type === 'function');
  if (funcExports.length === 0) {
    return generateGenericTests(name, exports, purpose);
  }

  const lines = [`describe('${name} middleware', () => {`];
  for (const exp of funcExports) {
    lines.push(
      '',
      `  describe("${exp.name}", () => {`,
      '    it("should call next() on success", () => {',
      '      const req = {} as any;',
      '      const res = {} as any;',
      '      const next = () => {};',
      `      // TODO: call ${exp.name}(req, res, next) and assert`,
      `      expect(${exp.name}).toBeDefined();`,
      '    });',
      '  });',
    );
  }
  lines.push('});');
  return lines;
}

function generateUtilTests(exports: ExportInfo[], purpose: string): string[] {
  if (exports.length === 0) {
    return ['// TODO: add tests for utility functions', ''];
  }

  const lines: string[] = [];
  for (const exp of exports) {
    lines.push(
      `describe('${exp.name}', () => {`,
      '  it("should work correctly", () => {',
      `    // TODO: test ${exp.name}`,
      `    expect(${exp.name}).toBeDefined();`,
      '  });',
      '});',
      '',
    );
  }
  return lines;
}

function generateGenericTests(name: string, exports: ExportInfo[], purpose: string): string[] {
  if (exports.length === 0) {
    return [
      `describe('${name}', () => {`,
      `  it('should work', () => {`,
      `    // TODO: implement test`,
      `    expect(true).toBe(true);`,
      '  });',
      '});',
    ];
  }

  const lines = [`describe('${name}', () => {`];
  for (const exp of exports) {
    lines.push(
      `  it('should export ${exp.name}', () => {`,
      `    expect(${exp.name}).toBeDefined();`,
      '  });',
      '',
    );
  }
  lines.push('});');
  return lines;
}

// --- Export extraction ---

interface ExportInfo {
  name: string;
  type: 'class' | 'function' | 'const' | 'interface' | 'default';
}

function extractExports(content: string): ExportInfo[] {
  const exports: ExportInfo[] = [];
  const seen = new Set<string>();

  const patterns: Array<{ regex: RegExp; type: ExportInfo['type'] }> = [
    { regex: /export\s+class\s+(\w+)/g, type: 'class' },
    { regex: /export\s+(?:async\s+)?function\s+(\w+)/g, type: 'function' },
    { regex: /export\s+const\s+(\w+)/g, type: 'const' },
    { regex: /export\s+default\s+/g, type: 'default' },
  ];

  for (const { regex, type } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = type === 'default' ? 'default' : match[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        exports.push({ name, type });
      }
    }
  }

  return exports;
}

function findPurposeInMap(structure: Record<string, MapNode>, filePath: string): string {
  const parts = filePath.split('/').filter(Boolean);
  let current: Record<string, MapNode> = structure;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const node = current[part];
    if (!node) return '';
    if (i === parts.length - 1) return node.purpose;
    if (!node.children) return '';
    current = node.children;
  }

  return '';
}
