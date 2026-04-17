import { describe, it, expect } from 'vitest';
import {
  toPascalCase,
  toCamelCase,
  toKebabCase,
  pluralize,
  pluralizeResource,
  findInterfaceBlock,
} from './naming.js';

describe('toPascalCase', () => {
  it('handles hyphenated names', () => {
    expect(toPascalCase('user-profile')).toBe('UserProfile');
    expect(toPascalCase('blog-post-comment')).toBe('BlogPostComment');
  });

  it('handles snake_case names', () => {
    expect(toPascalCase('user_profile')).toBe('UserProfile');
  });

  it('handles already-cased names', () => {
    expect(toPascalCase('UserProfile')).toBe('UserProfile');
    expect(toPascalCase('userProfile')).toBe('UserProfile');
  });

  it('handles single words', () => {
    expect(toPascalCase('user')).toBe('User');
    expect(toPascalCase('USER')).toBe('User');
  });
});

describe('toCamelCase', () => {
  it('handles hyphens', () => {
    expect(toCamelCase('user-profile')).toBe('userProfile');
  });
  it('lowercases first letter', () => {
    expect(toCamelCase('User')).toBe('user');
  });
});

describe('toKebabCase', () => {
  it('splits camelCase into kebab', () => {
    expect(toKebabCase('UserProfile')).toBe('user-profile');
    expect(toKebabCase('userProfile')).toBe('user-profile');
  });
});

describe('pluralize', () => {
  it('handles irregulars', () => {
    expect(pluralize('person')).toBe('people');
    expect(pluralize('child')).toBe('children');
    expect(pluralize('Person')).toBe('People');
  });

  it('handles consonant + y', () => {
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('city')).toBe('cities');
  });

  it('handles s/x/z/ch/sh suffixes', () => {
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('class')).toBe('classes');
    expect(pluralize('watch')).toBe('watches');
  });

  it('handles -f and -fe', () => {
    expect(pluralize('leaf')).toBe('leaves');
    expect(pluralize('knife')).toBe('knives');
  });

  it('respects uncountables', () => {
    expect(pluralize('fish')).toBe('fish');
    expect(pluralize('information')).toBe('information');
  });

  it('falls back to +s', () => {
    expect(pluralize('user')).toBe('users');
    expect(pluralize('post')).toBe('posts');
  });
});

describe('pluralizeResource', () => {
  it('pluralizes the last segment of a hyphenated name', () => {
    expect(pluralizeResource('user-profile')).toBe('user-profiles');
    expect(pluralizeResource('blog-category')).toBe('blog-categories');
  });
});

describe('findInterfaceBlock', () => {
  it('locates a flat interface', () => {
    const src = `export interface User {\n  name: string;\n}`;
    const block = findInterfaceBlock(src, 'User');
    expect(block).not.toBeNull();
    expect(block!.body).toContain('name: string');
  });

  it('handles nested braces correctly', () => {
    const src = [
      'export interface User {',
      '  settings: { theme: string; dark: boolean };',
      '  name: string;',
      '}',
    ].join('\n');
    const block = findInterfaceBlock(src, 'User');
    expect(block).not.toBeNull();
    // A naive regex would terminate at the first `}` and miss `name`.
    expect(block!.body).toContain('name: string');
    expect(src.slice(block!.closeBrace, block!.closeBrace + 1)).toBe('}');
  });

  it('returns null when interface is absent', () => {
    expect(findInterfaceBlock('no interface here', 'User')).toBeNull();
  });

  it('ignores braces inside strings', () => {
    const src = `export interface User {\n  hint: "use { like this }";\n  name: string;\n}`;
    const block = findInterfaceBlock(src, 'User');
    expect(block).not.toBeNull();
    expect(block!.body).toContain('name: string');
  });
});
