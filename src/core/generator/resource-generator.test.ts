import { describe, it, expect } from 'vitest';
import { ResourceGenerator } from './resource-generator.js';
import type { PillarConfig } from '../config/index.js';

function makeConfig(overrides: Partial<PillarConfig['project']> = {}): PillarConfig {
  return {
    project: {
      name: 'test-app',
      platform: 'web',
      category: 'api',
      stack: 'express',
      language: 'typescript',
      architecture: 'feature-first',
      packageManager: 'npm',
      ...overrides,
    },
    database: { type: 'postgresql', orm: 'prisma' },
    generation: { overwrite: false, dryRun: false, testFramework: 'vitest', purposeRequired: true },
    map: { autoUpdate: true, format: ['json', 'markdown'] },
    extras: { docker: false, linting: false, gitHooks: false },
  };
}

describe('ResourceGenerator', () => {
  describe('feature-first architecture', () => {
    it('generates all 8 resource files', () => {
      const gen = new ResourceGenerator(makeConfig());
      const files = gen.generate({ name: 'user' });
      expect(files.length).toBe(8);
      expect(files.map((f) => f.relativePath)).toEqual([
        'src/features/user/user.model.ts',
        'src/features/user/user.repository.ts',
        'src/features/user/user.service.ts',
        'src/features/user/user.controller.ts',
        'src/features/user/user.routes.ts',
        'src/features/user/user.validator.ts',
        'src/features/user/user.types.ts',
        'src/features/user/user.test.ts',
      ]);
    });
  });

  describe('layered architecture', () => {
    it('places files in kind-specific directories', () => {
      const gen = new ResourceGenerator(makeConfig({ architecture: 'layered' }));
      const files = gen.generate({ name: 'user' });
      const paths = files.map((f) => f.relativePath);

      expect(paths).toContain('src/models/user.model.ts');
      expect(paths).toContain('src/repositories/user.repository.ts');
      expect(paths).toContain('src/services/user.service.ts');
      expect(paths).toContain('src/controllers/user.controller.ts');
      expect(paths).toContain('src/routes/user.routes.ts');
      expect(paths).toContain('src/validators/user.validator.ts');
      expect(paths).toContain('src/types/user.types.ts');
      expect(paths).toContain('src/tests/user.test.ts');
    });
  });

  describe('modular architecture', () => {
    it('places files in module directory', () => {
      const gen = new ResourceGenerator(makeConfig({ architecture: 'modular' }));
      const files = gen.generate({ name: 'product' });
      for (const file of files) {
        expect(file.relativePath).toMatch(/^src\/modules\/product\//);
      }
    });
  });

  describe('options', () => {
    it('respects skipTest', () => {
      const gen = new ResourceGenerator(makeConfig());
      const files = gen.generate({ name: 'user', skipTest: true });
      expect(files.find((f) => f.relativePath.includes('.test.'))).toBeUndefined();
    });

    it('respects only filter', () => {
      const gen = new ResourceGenerator(makeConfig());
      const files = gen.generate({ name: 'user', only: ['service', 'controller'] });
      expect(files.length).toBe(2);
      expect(files[0]!.relativePath).toContain('.service.');
      expect(files[1]!.relativePath).toContain('.controller.');
    });

    it('omits routes for NestJS', () => {
      const gen = new ResourceGenerator(makeConfig({ stack: 'nestjs' }));
      const files = gen.generate({ name: 'user' });
      expect(files.find((f) => f.relativePath.includes('.routes.'))).toBeUndefined();
    });

    it('omits types for JavaScript', () => {
      const gen = new ResourceGenerator(makeConfig({ language: 'javascript' }));
      const files = gen.generate({ name: 'user' });
      expect(files.find((f) => f.relativePath.includes('.types.'))).toBeUndefined();
      for (const file of files) {
        expect(file.relativePath).toMatch(/\.js$/);
      }
    });
  });

  describe('generated content', () => {
    it('each file has non-empty content and purpose', () => {
      const gen = new ResourceGenerator(makeConfig());
      const files = gen.generate({ name: 'order' });
      for (const file of files) {
        expect(file.content.length).toBeGreaterThan(0);
        expect(file.purpose.length).toBeGreaterThan(0);
        expect(file.content).toContain('// Purpose:');
      }
    });
  });
});
