import { describe, it, expect } from 'vitest';
import { resolveResourcePath, resolveResourceFilePath } from './resolve-resource-path.js';

describe('resolveResourcePath', () => {
  it('returns feature-first path', () => {
    expect(resolveResourcePath('feature-first', 'user')).toBe('src/features/user');
  });

  it('returns layered path (flat src)', () => {
    expect(resolveResourcePath('layered', 'user')).toBe('src');
  });

  it('returns modular path', () => {
    expect(resolveResourcePath('modular', 'user')).toBe('src/modules/user');
  });

  it('defaults to feature-first for unknown architecture', () => {
    expect(resolveResourcePath('unknown' as never, 'user')).toBe('src/features/user');
  });

  it('includes the resource name in the path', () => {
    expect(resolveResourcePath('feature-first', 'product')).toBe('src/features/product');
    expect(resolveResourcePath('modular', 'order')).toBe('src/modules/order');
  });
});

describe('resolveResourceFilePath', () => {
  it('feature-first: places files in resource directory', () => {
    expect(resolveResourceFilePath('feature-first', 'user', 'model', 'ts'))
      .toBe('src/features/user/user.model.ts');
    expect(resolveResourceFilePath('feature-first', 'user', 'controller', 'ts'))
      .toBe('src/features/user/user.controller.ts');
  });

  it('layered: places files in kind-specific subdirectories', () => {
    expect(resolveResourceFilePath('layered', 'user', 'model', 'ts'))
      .toBe('src/models/user.model.ts');
    expect(resolveResourceFilePath('layered', 'user', 'controller', 'ts'))
      .toBe('src/controllers/user.controller.ts');
    expect(resolveResourceFilePath('layered', 'user', 'repository', 'ts'))
      .toBe('src/repositories/user.repository.ts');
    expect(resolveResourceFilePath('layered', 'user', 'service', 'ts'))
      .toBe('src/services/user.service.ts');
  });

  it('modular: places files in module directory', () => {
    expect(resolveResourceFilePath('modular', 'user', 'model', 'ts'))
      .toBe('src/modules/user/user.model.ts');
  });

  it('handles js extension', () => {
    expect(resolveResourceFilePath('layered', 'user', 'model', 'js'))
      .toBe('src/models/user.model.js');
  });
});
