import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'fs-extra';
import os from 'node:os';
import { executePlan } from './plan-executor.js';
import type { PillarConfig } from '../config/index.js';
import type { AIGenerationPlan } from './types.js';

const CONFIG: PillarConfig = {
  project: {
    name: 'test-app',
    platform: 'web',
    category: 'api',
    stack: 'express',
    language: 'typescript',
    architecture: 'feature-first',
    packageManager: 'npm',
  },
  database: { type: 'none', orm: 'none' },
  generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
  map: { autoUpdate: true, format: ['json', 'markdown'] },
  extras: { docker: false, linting: false, gitHooks: false },
};

describe('executePlan', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pillar-plan-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  describe('create actions', () => {
    it('uses skeleton engine when no content is provided', async () => {
      const plan: AIGenerationPlan = {
        summary: 'Add user service',
        create: [
          { path: 'src/features/user/user.service.ts', purpose: 'User business logic', kind: 'service' },
        ],
        modify: [],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.createdFiles).toEqual(['src/features/user/user.service.ts']);

      const content = await fs.readFile(path.join(tmpDir, 'src/features/user/user.service.ts'), 'utf-8');
      expect(content).toContain('export class UserService');
      expect(content).toContain('// Purpose: User business logic');
    });

    it('uses AI-provided content when available', async () => {
      const customContent = [
        'const startTime = Date.now();',
        '',
        'export function healthCheck() {',
        '  return {',
        '    status: "ok",',
        '    uptime: Math.floor((Date.now() - startTime) / 1000),',
        '  };',
        '}',
      ].join('\n');

      const plan: AIGenerationPlan = {
        summary: 'Add health check',
        create: [
          { path: 'src/health.ts', purpose: 'Health check endpoint', kind: 'generic', content: customContent },
        ],
        modify: [],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.createdFiles).toEqual(['src/health.ts']);

      const content = await fs.readFile(path.join(tmpDir, 'src/health.ts'), 'utf-8');
      expect(content).toContain('// Purpose: Health check endpoint');
      expect(content).toContain('const startTime = Date.now()');
      expect(content).toContain('export function healthCheck()');
    });

    it('skips existing files', async () => {
      const existingPath = path.join(tmpDir, 'src/existing.ts');
      await fs.ensureDir(path.dirname(existingPath));
      await fs.writeFile(existingPath, 'original content', 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'test',
        create: [{ path: 'src/existing.ts', purpose: 'test', kind: 'generic' }],
        modify: [],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.createdFiles).toEqual([]);

      const content = await fs.readFile(existingPath, 'utf-8');
      expect(content).toBe('original content');
    });
  });

  describe('modify actions — imports', () => {
    it('injects imports after existing import block', async () => {
      const appFile = path.join(tmpDir, 'src/app.ts');
      await fs.ensureDir(path.dirname(appFile));
      await fs.writeFile(appFile, [
        "import express from 'express';",
        "import cors from 'cors';",
        '',
        'const app = express();',
        'app.use(cors());',
        '',
        'export { app };',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'Register health routes',
        create: [],
        modify: [{
          path: 'src/app.ts',
          purpose: 'Register health routes',
          kind: 'generic',
          imports: ["import { healthRouter } from './health.routes.js';"],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.modifiedFiles).toEqual(['src/app.ts']);

      const content = await fs.readFile(appFile, 'utf-8');
      const lines = content.split('\n');
      // Import should be after the existing imports
      expect(lines[2]).toBe("import { healthRouter } from './health.routes.js';");
      // Rest of file should be intact
      expect(content).toContain('export { app }');
    });

    it('does not duplicate existing imports', async () => {
      const appFile = path.join(tmpDir, 'src/app.ts');
      await fs.ensureDir(path.dirname(appFile));
      await fs.writeFile(appFile, [
        "import express from 'express';",
        "import { healthRouter } from './health.routes.js';",
        '',
        'const app = express();',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'test',
        create: [],
        modify: [{
          path: 'src/app.ts',
          purpose: 'test',
          kind: 'generic',
          imports: ["import { healthRouter } from './health.routes.js';"],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      // No changes since import already exists
      expect(result.modifiedFiles).toEqual([]);
    });
  });

  describe('modify actions — registrations', () => {
    it('injects registrations before TODO comment', async () => {
      const appFile = path.join(tmpDir, 'src/app.ts');
      await fs.ensureDir(path.dirname(appFile));
      await fs.writeFile(appFile, [
        "import express from 'express';",
        '',
        'const app = express();',
        '',
        '// TODO: register feature routes here',
        '',
        'export { app };',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'Register health routes',
        create: [],
        modify: [{
          path: 'src/app.ts',
          purpose: 'Register health routes',
          kind: 'generic',
          registrations: ["app.use('/health', healthRouter);"],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.modifiedFiles).toEqual(['src/app.ts']);

      const content = await fs.readFile(appFile, 'utf-8');
      expect(content).toContain("app.use('/health', healthRouter);");
      // Should be before the TODO, not after export
      const regIndex = content.indexOf("app.use('/health'");
      const todoIndex = content.indexOf('// TODO: register');
      const exportIndex = content.indexOf('export { app }');
      expect(regIndex).toBeLessThan(todoIndex);
      expect(regIndex).toBeLessThan(exportIndex);
    });

    it('injects before export { app } when no TODO marker', async () => {
      const appFile = path.join(tmpDir, 'src/app.ts');
      await fs.ensureDir(path.dirname(appFile));
      await fs.writeFile(appFile, [
        "import express from 'express';",
        '',
        'const app = express();',
        '',
        'export { app };',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'test',
        create: [],
        modify: [{
          path: 'src/app.ts',
          purpose: 'test',
          kind: 'generic',
          registrations: ["app.use('/api', apiRouter);"],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      const content = await fs.readFile(appFile, 'utf-8');
      const regIndex = content.indexOf("app.use('/api'");
      const exportIndex = content.indexOf('export { app }');
      expect(regIndex).toBeLessThan(exportIndex);
    });
  });

  describe('modify actions — methods', () => {
    it('injects methods into a class body, not export blocks', async () => {
      const controllerFile = path.join(tmpDir, 'src/user.controller.ts');
      await fs.ensureDir(path.dirname(controllerFile));
      await fs.writeFile(controllerFile, [
        'export class UserController {',
        '  async findAll(req: Request, res: Response) {',
        '    res.json([]);',
        '  }',
        '}',
        '',
        'export { something };',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'Add search method',
        create: [],
        modify: [{
          path: 'src/user.controller.ts',
          purpose: 'Add search endpoint',
          kind: 'controller',
          methods: [{ name: 'search', description: 'Search users by query' }],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.modifiedFiles).toEqual(['src/user.controller.ts']);

      const content = await fs.readFile(controllerFile, 'utf-8');
      expect(content).toContain('async search(req: Request, res: Response)');
      // The export block should still be intact
      expect(content).toContain('export { something }');
      // Method should be inside the class, before the class closing brace
      const methodIndex = content.indexOf('async search');
      const classEnd = content.indexOf('}', content.indexOf('export class'));
      expect(methodIndex).toBeLessThan(content.lastIndexOf('export { something }'));
    });

    it('does not duplicate existing methods', async () => {
      const file = path.join(tmpDir, 'src/svc.ts');
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, [
        'export class Svc {',
        '  async doStuff() { }',
        '}',
      ].join('\n'), 'utf-8');

      const plan: AIGenerationPlan = {
        summary: 'test',
        create: [],
        modify: [{
          path: 'src/svc.ts',
          purpose: 'test',
          kind: 'service',
          methods: [{ name: 'doStuff', description: 'already exists' }],
        }],
      };

      const result = await executePlan(tmpDir, CONFIG, plan);
      expect(result.modifiedFiles).toEqual([]);
    });
  });
});
