import { describe, it, expect } from 'vitest';
import { inferFileKind, generateSkeleton } from './skeleton.js';

describe('inferFileKind', () => {
  it('detects controller files', () => {
    expect(inferFileKind('user.controller.ts')).toBe('controller');
  });

  it('detects service files', () => {
    expect(inferFileKind('user.service.ts')).toBe('service');
  });

  it('detects repository files', () => {
    expect(inferFileKind('user.repository.ts')).toBe('repository');
    expect(inferFileKind('user.repo.ts')).toBe('repository');
  });

  it('detects model files', () => {
    expect(inferFileKind('user.model.ts')).toBe('model');
    expect(inferFileKind('user.entity.ts')).toBe('model');
    expect(inferFileKind('user.schema.ts')).toBe('model');
  });

  it('detects routes files', () => {
    expect(inferFileKind('user.routes.ts')).toBe('routes');
    expect(inferFileKind('user.router.ts')).toBe('routes');
  });

  it('detects validator files', () => {
    expect(inferFileKind('user.validator.ts')).toBe('validator');
    expect(inferFileKind('user.validation.ts')).toBe('validator');
  });

  it('detects types files', () => {
    expect(inferFileKind('user.types.ts')).toBe('types');
    expect(inferFileKind('user.dto.ts')).toBe('types');
  });

  it('detects test files', () => {
    expect(inferFileKind('user.test.ts')).toBe('test');
    expect(inferFileKind('user.spec.ts')).toBe('test');
  });

  it('detects middleware files', () => {
    expect(inferFileKind('auth.middleware.ts')).toBe('middleware');
  });

  it('detects util files', () => {
    expect(inferFileKind('hash.util.ts')).toBe('util');
    expect(inferFileKind('hash.helper.ts')).toBe('util');
    expect(inferFileKind('hash.utils.ts')).toBe('util');
  });

  it('detects component files', () => {
    expect(inferFileKind('Navbar.tsx')).toBe('component');
    expect(inferFileKind('Button.jsx')).toBe('component');
  });

  it('returns generic for unknown patterns', () => {
    expect(inferFileKind('server.ts')).toBe('generic');
    expect(inferFileKind('index.ts')).toBe('generic');
  });
});

describe('generateSkeleton', () => {
  it('includes a purpose header', () => {
    const result = generateSkeleton('user.service.ts', 'Business logic for user');
    expect(result).toContain('// Purpose: Business logic for user');
  });

  it('generates a service class', () => {
    const result = generateSkeleton('user.service.ts', 'Business logic', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('export class UserService');
    expect(result).toContain('async findAll()');
    expect(result).toContain('async findOne(id: string)');
    expect(result).toContain('async create(data: Partial<User>)');
  });

  it('generates a controller class', () => {
    const result = generateSkeleton('user.controller.ts', 'HTTP handlers', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('export class UserController');
    expect(result).toContain('UserService');
  });

  it('generates NestJS controller with decorators', () => {
    const result = generateSkeleton('user.controller.ts', 'HTTP handlers', {
      stack: 'nestjs',
      language: 'typescript',
    });
    expect(result).toContain("@Controller('users')");
    expect(result).toContain('@Get()');
    expect(result).toContain('@Post()');
  });

  it('generates Express routes with arrow functions to preserve this', () => {
    const result = generateSkeleton('user.routes.ts', 'Routes', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('(req, res) => controller.findAll(req, res)');
    expect(result).not.toContain('controller.findAll);');
  });

  it('generates Fastify routes with arrow functions', () => {
    const result = generateSkeleton('user.routes.ts', 'Routes', {
      stack: 'fastify',
      language: 'typescript',
    });
    expect(result).toContain('(req, res) => controller.findAll(req, res)');
    expect(result).toContain('FastifyInstance');
  });

  it('generates Hono routes with context parameter', () => {
    const result = generateSkeleton('user.routes.ts', 'Routes', {
      stack: 'hono',
      language: 'typescript',
    });
    expect(result).toContain('(c) => controller.findAll(c)');
    expect(result).toContain("import { Hono } from 'hono'");
  });

  it('generates TypeScript interface for model', () => {
    const result = generateSkeleton('user.model.ts', 'Data model', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('export interface User');
    expect(result).toContain('id: string');
    expect(result).toContain('createdAt: Date');
  });

  it('generates JSDoc for JS model', () => {
    const result = generateSkeleton('user.model.js', 'Data model', {
      stack: 'express',
      language: 'javascript',
    });
    expect(result).toContain('@typedef {Object} User');
    expect(result).not.toContain('export interface');
  });

  it('generates Zod validator for TS', () => {
    const result = generateSkeleton('user.validator.ts', 'Validation', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain("import { z } from 'zod'");
    expect(result).toContain('createUserSchema = z.object');
  });

  it('generates plain validator for JS', () => {
    const result = generateSkeleton('user.validator.js', 'Validation', {
      stack: 'express',
      language: 'javascript',
    });
    expect(result).toContain('function validateCreateUser(data)');
    expect(result).not.toContain('z.object');
  });

  it('generates vitest test by default', () => {
    const result = generateSkeleton('user.test.ts', 'Tests', {
      stack: 'express',
      language: 'typescript',
      testFramework: 'vitest',
    });
    expect(result).toContain("from 'vitest'");
  });

  it('generates jest test when configured', () => {
    const result = generateSkeleton('user.test.ts', 'Tests', {
      stack: 'express',
      language: 'typescript',
      testFramework: 'jest',
    });
    expect(result).toContain("from '@jest/globals'");
  });

  it('generates a repository class', () => {
    const result = generateSkeleton('user.repository.ts', 'Data access', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('export class UserRepository');
    expect(result).toContain('Promise<User[]>');
  });

  it('generates types file', () => {
    const result = generateSkeleton('user.types.ts', 'Types', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('export interface User');
    expect(result).toContain('UserListResponse');
  });

  it('generates middleware', () => {
    const result = generateSkeleton('auth.middleware.ts', 'Auth check', {
      stack: 'express',
      language: 'typescript',
    });
    expect(result).toContain('Middleware');
    expect(result).toContain('next');
  });

  it('generates a React component for tsx', () => {
    const result = generateSkeleton('Navbar.tsx', 'Navigation bar');
    expect(result).toContain('export function Navbar()');
    expect(result).toContain('return (');
  });
});
