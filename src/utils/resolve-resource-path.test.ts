import { describe, it, expect } from 'vitest';
import { resolveResourcePath } from './resolve-resource-path.js';

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
