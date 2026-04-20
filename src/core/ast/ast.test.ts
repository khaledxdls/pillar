import { describe, it, expect } from 'vitest';
import {
  addFieldsToInterface,
  addFieldsToZodObjectSchema,
  ensureNamedImport,
  addMethodToClass,
  addElementToDecoratorArray,
  appendStatementToFunction,
  addModuleStatement,
} from './index.js';

describe('addFieldsToInterface', () => {
  it('adds missing fields', () => {
    const src = `export interface User {\n  id: string;\n}\n`;
    const out = addFieldsToInterface(src, 'User', [
      { name: 'name', type: 'string' },
      { name: 'age', type: 'number', optional: true },
    ]);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/name: string;/);
    expect(out!).toMatch(/age\?: number;/);
  });

  it('is idempotent on field name', () => {
    const src = `export interface User {\n  name: string;\n}\n`;
    const out = addFieldsToInterface(src, 'User', [{ name: 'name', type: 'string' }]);
    expect(out!.match(/name: string;/g)!.length).toBe(1);
  });

  it('returns null when interface absent', () => {
    expect(addFieldsToInterface(`const x = 1;`, 'User', [{ name: 'a', type: 'string' }])).toBeNull();
  });

  it('handles nested object types without corruption', () => {
    const src = `export interface User {\n  settings: { theme: string; dark: boolean };\n}\n`;
    const out = addFieldsToInterface(src, 'User', [{ name: 'name', type: 'string' }]);
    expect(out!).toMatch(/settings:/);
    expect(out!).toMatch(/name: string;/);
    expect(out!.match(/\}/g)!.length).toBe(2); // nested + outer
  });
});

describe('addFieldsToZodObjectSchema', () => {
  it('adds fields to z.object literal', () => {
    const src = `import { z } from 'zod';\nexport const createUserSchema = z.object({ email: z.string() });\n`;
    const out = addFieldsToZodObjectSchema(src, 'createUserSchema', [
      { name: 'name', expression: 'z.string()' },
    ]);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/name: z\.string\(\)/);
  });

  it('skips duplicates', () => {
    const src = `import { z } from 'zod';\nexport const s = z.object({ name: z.string() });\n`;
    const out = addFieldsToZodObjectSchema(src, 's', [{ name: 'name', expression: 'z.string()' }])!;
    expect(out.match(/name: z\.string\(\)/g)!.length).toBe(1);
  });
});

describe('ensureNamedImport', () => {
  it('adds a new import', () => {
    const out = ensureNamedImport('const a = 1;\n', './foo.js', 'Foo');
    expect(out).toMatch(/import \{ Foo \} from "\.\/foo\.js"/);
  });

  it('merges into an existing named import from the same module', () => {
    const src = `import { Bar } from './foo.js';\nconst a = 1;\n`;
    const out = ensureNamedImport(src, './foo.js', 'Foo');
    expect(out).toMatch(/import \{ Bar, Foo \} from ['"]\.\/foo\.js['"]/);
  });

  it('is idempotent', () => {
    const src = `import { Foo } from './foo.js';\n`;
    expect(ensureNamedImport(src, './foo.js', 'Foo').match(/Foo/g)!.length).toBe(1);
  });
});

describe('addMethodToClass', () => {
  it('appends a method to a class', () => {
    const src = `export class Foo {\n  a() { return 1; }\n}\n`;
    const out = addMethodToClass(src, 'Foo', `async bar() {\n  return 2;\n}`);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/async bar\(\)/);
  });

  it('is idempotent on method name', () => {
    const src = `export class Foo {\n  async bar() {}\n}\n`;
    const out = addMethodToClass(src, 'Foo', `async bar() {\n  return 2;\n}`);
    expect(out!.match(/async bar/g)!.length).toBe(1);
  });
});

describe('addElementToDecoratorArray', () => {
  it('extends an existing array', () => {
    const src = `import { Module } from '@nestjs/common';\n@Module({ controllers: [FooController] })\nexport class AppModule {}\n`;
    const out = addElementToDecoratorArray(src, 'Module', 'controllers', 'BarController');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/\[FooController, BarController\]/);
  });

  it('creates the property if missing', () => {
    const src = `import { Module } from '@nestjs/common';\n@Module({})\nexport class AppModule {}\n`;
    const out = addElementToDecoratorArray(src, 'Module', 'providers', 'FooService');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/providers: \[FooService\]/);
  });

  it('is idempotent', () => {
    const src = `import { Module } from '@nestjs/common';\n@Module({ controllers: [Foo] })\nexport class AppModule {}\n`;
    const out = addElementToDecoratorArray(src, 'Module', 'controllers', 'Foo')!;
    expect(out.match(/Foo/g)!.length).toBe(1); // stays in array, not duplicated
  });
});

describe('appendStatementToFunction', () => {
  it('appends a statement to an exported async function body', () => {
    const src = `export async function userRoutes(app) {\n  app.get('/users', h);\n}\n`;
    const out = appendStatementToFunction(src, 'userRoutes', `app.post('/users', h);`);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/app\.get\('\/users', h\);/);
    expect(out!).toMatch(/app\.post\('\/users', h\);/);
  });

  it('works for arrow-function variable bindings', () => {
    const src = `const boot = async (app) => {\n  app.listen(3000);\n};\n`;
    const out = appendStatementToFunction(src, 'boot', `app.ready();`);
    expect(out).not.toBeNull();
    expect(out!).toMatch(/app\.ready\(\);/);
  });

  it('is idempotent on verbatim statement text', () => {
    const src = `export async function routes(app) {\n  app.get('/x', h);\n}\n`;
    const out = appendStatementToFunction(src, 'routes', `app.get('/x', h);`)!;
    expect(out.match(/app\.get\('\/x', h\);/g)!.length).toBe(1);
  });

  it('returns null when the function is not present', () => {
    expect(appendStatementToFunction(`const x = 1;`, 'missing', `x;`)).toBeNull();
  });

  it('returns null for concise-body arrows (no block)', () => {
    const src = `const f = (x) => x + 1;\n`;
    expect(appendStatementToFunction(src, 'f', `x;`)).toBeNull();
  });
});

describe('addModuleStatement', () => {
  it('appends at module scope by default', () => {
    const src = `const a = 1;\n`;
    const out = addModuleStatement(src, `const b = 2;`);
    expect(out).toMatch(/const a = 1;/);
    expect(out).toMatch(/const b = 2;/);
  });

  it('inserts before the last export declaration when beforeLastExport is set', () => {
    const src = `const router = {};\nexport { router as userRouter };\n`;
    const out = addModuleStatement(src, `router.get('/x', h);`, { beforeLastExport: true });
    const routerIdx = out.indexOf(`router.get('/x', h);`);
    const exportIdx = out.indexOf(`export { router`);
    expect(routerIdx).toBeGreaterThan(-1);
    expect(routerIdx).toBeLessThan(exportIdx);
  });

  it('is idempotent on verbatim statement text', () => {
    const src = `router.get('/a', h);\nexport { router };\n`;
    const out = addModuleStatement(src, `router.get('/a', h);`, { beforeLastExport: true });
    expect(out.match(/router\.get\('\/a', h\);/g)!.length).toBe(1);
  });

  it('falls back to append when beforeLastExport is set but no export exists', () => {
    const src = `const a = 1;\n`;
    const out = addModuleStatement(src, `const b = 2;`, { beforeLastExport: true });
    expect(out).toMatch(/const b = 2;/);
  });
});
