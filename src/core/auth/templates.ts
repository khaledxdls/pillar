import type { PillarConfig } from '../config/index.js';

/**
 * Stack-aware source templates for the auth module scaffold.
 *
 * Design notes:
 *   - All templates assume TypeScript; JS projects are rejected upstream
 *     (the JWT + zod combination leans heavily on compile-time typing).
 *   - Imports are fully-qualified `.js` (ESM / Node16 module resolution).
 *   - The service is stack-agnostic and depends only on `bcryptjs` +
 *     `jsonwebtoken` + zod — all controllers/routes/middleware target it.
 *   - The repository is a minimal in-memory stub so the scaffold compiles
 *     and runs out of the box; users are expected to swap it for their
 *     real persistence layer.
 *
 * Every template embeds a `// Purpose:` header so the project map and the
 * AI two-pass planner can reason about intent without reading the body.
 */

export interface AuthTemplateContext {
  /** Relative import from one auth file to another (`./` for co-located, `../auth/` for layered). */
  peer(suffix: string): string;
  isTS: boolean;
}

export function jwtUtilSource(_config: PillarConfig, _ctx: AuthTemplateContext): string {
  return `// Purpose: Sign and verify JWTs for authentication flows.

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

export interface TokenPayload extends JwtPayload {
  sub: string;
  email: string;
}

function getSecret(): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret || secret.length < 16) {
    throw new Error(
      'JWT_SECRET is not set or is too short (min 16 chars). ' +
        'Set it in .env — never commit the value.',
    );
  }
  return secret;
}

export function signToken(payload: Pick<TokenPayload, 'sub' | 'email'>): string {
  const expiresIn = (process.env['JWT_EXPIRES_IN'] ?? '1h') as SignOptions['expiresIn'];
  return jwt.sign(payload, getSecret(), { expiresIn });
}

export function verifyToken(token: string): TokenPayload {
  const decoded = jwt.verify(token, getSecret());
  if (typeof decoded === 'string') {
    throw new Error('Invalid token payload');
  }
  return decoded as TokenPayload;
}
`;
}

export function authTypesSource(_config: PillarConfig, _ctx: AuthTemplateContext): string {
  return `// Purpose: Shared types for the auth module.

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicUser = Omit<AuthUser, 'passwordHash'>;

export interface AuthResponse {
  user: PublicUser;
  token: string;
}
`;
}

export function authValidatorSource(_config: PillarConfig, _ctx: AuthTemplateContext): string {
  return `// Purpose: Zod schemas for auth endpoints — single source of truth for shapes + types.

import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(72), // bcrypt truncates past 72 bytes
});

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
`;
}

export function authRepositorySource(_config: PillarConfig, _ctx: AuthTemplateContext): string {
  return `// Purpose: User persistence for auth — replace the in-memory store with your real DB layer.

import type { AuthUser } from './auth.types.js';

/**
 * Minimal in-memory user store so the scaffold compiles and boots out of
 * the box. Swap the method bodies for queries against your real database
 * (Postgres, Mongo, etc.) — the signatures are stable.
 */
export class AuthRepository {
  private readonly users = new Map<string, AuthUser>();

  async findByEmail(email: string): Promise<AuthUser | null> {
    for (const u of this.users.values()) {
      if (u.email === email) return u;
    }
    return null;
  }

  async findById(id: string): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async create(user: Omit<AuthUser, 'id' | 'createdAt' | 'updatedAt'>): Promise<AuthUser> {
    const now = new Date();
    const record: AuthUser = {
      id: cryptoRandomId(),
      ...user,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(record.id, record);
    return record;
  }
}

function cryptoRandomId(): string {
  // Avoid Node's \`crypto.randomUUID\` import to keep this file runnable
  // under older Node runtimes; the hex form is sufficient for a dev stub.
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  );
}
`;
}

export function authServiceSource(_config: PillarConfig, ctx: AuthTemplateContext): string {
  return `// Purpose: Business logic for registration, login, and session introspection.

import bcrypt from 'bcryptjs';
import { AuthRepository } from '${ctx.peer('repository')}';
import { signToken, verifyToken, type TokenPayload } from '${ctx.peer('jwt.util')}';
import type { AuthResponse, AuthUser, PublicUser } from '${ctx.peer('types')}';
import type { LoginInput, RegisterInput } from '${ctx.peer('validator')}';

const BCRYPT_ROUNDS = 12;

export class AuthService {
  constructor(private readonly repo: AuthRepository = new AuthRepository()) {}

  async register(input: RegisterInput): Promise<AuthResponse> {
    const existing = await this.repo.findByEmail(input.email);
    if (existing) {
      throw new AuthError('EMAIL_TAKEN', 'An account with this email already exists.');
    }
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.repo.create({ email: input.email, passwordHash });
    return { user: toPublic(user), token: signToken({ sub: user.id, email: user.email }) };
  }

  async login(input: LoginInput): Promise<AuthResponse> {
    const user = await this.repo.findByEmail(input.email);
    // Always run bcrypt.compare to prevent user-enumeration via timing.
    const matches = user
      ? await bcrypt.compare(input.password, user.passwordHash)
      : await bcrypt.compare(input.password, '$2a$12$aaaaaaaaaaaaaaaaaaaaaa');
    if (!user || !matches) {
      throw new AuthError('INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }
    return { user: toPublic(user), token: signToken({ sub: user.id, email: user.email }) };
  }

  async introspect(token: string): Promise<PublicUser> {
    let payload: TokenPayload;
    try {
      payload = verifyToken(token);
    } catch {
      throw new AuthError('INVALID_TOKEN', 'Token is invalid or expired.');
    }
    const user = await this.repo.findById(payload.sub);
    if (!user) throw new AuthError('INVALID_TOKEN', 'Token subject no longer exists.');
    return toPublic(user);
  }
}

export type AuthErrorCode = 'EMAIL_TAKEN' | 'INVALID_CREDENTIALS' | 'INVALID_TOKEN';

export class AuthError extends Error {
  constructor(public readonly code: AuthErrorCode, message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

function toPublic(u: AuthUser): PublicUser {
  const { passwordHash: _passwordHash, ...rest } = u;
  return rest;
}
`;
}

/**
 * Controllers differ significantly per stack — the argument shape, response
 * helpers, and router registration are all framework-specific.
 */
export function authControllerSource(config: PillarConfig, ctx: AuthTemplateContext): string {
  const stack = config.project.stack;

  if (stack === 'express') {
    return `// Purpose: Express handlers for auth endpoints.

import type { Request, Response, NextFunction } from 'express';
import { AuthService, AuthError } from '${ctx.peer('service')}';
import { loginSchema, registerSchema } from '${ctx.peer('validator')}';

const service = new AuthService();

export class AuthController {
  async register(req: Request, res: Response, next: NextFunction) {
    try {
      const input = registerSchema.parse(req.body);
      const result = await service.register(input);
      res.status(201).json(result);
    } catch (err) { next(err); }
  }

  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const input = loginSchema.parse(req.body);
      const result = await service.login(input);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(401).json({ code: err.code, message: err.message });
        return;
      }
      next(err);
    }
  }

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      // authenticate() middleware attaches \`user\` to the request.
      const user = (req as Request & { user?: unknown }).user;
      if (!user) {
        res.status(401).json({ code: 'INVALID_TOKEN', message: 'Not authenticated.' });
        return;
      }
      res.status(200).json({ user });
    } catch (err) { next(err); }
  }
}
`;
  }

  if (stack === 'fastify') {
    return `// Purpose: Fastify handlers for auth endpoints.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService, AuthError } from '${ctx.peer('service')}';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '${ctx.peer('validator')}';

const service = new AuthService();

export class AuthController {
  async register(req: FastifyRequest<{ Body: RegisterInput }>, res: FastifyReply) {
    const input = registerSchema.parse(req.body);
    const result = await service.register(input);
    return res.status(201).send(result);
  }

  async login(req: FastifyRequest<{ Body: LoginInput }>, res: FastifyReply) {
    try {
      const input = loginSchema.parse(req.body);
      const result = await service.login(input);
      return res.status(200).send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return res.status(401).send({ code: err.code, message: err.message });
      }
      throw err;
    }
  }

  async me(req: FastifyRequest, res: FastifyReply) {
    const user = (req as FastifyRequest & { user?: unknown }).user;
    if (!user) return res.status(401).send({ code: 'INVALID_TOKEN', message: 'Not authenticated.' });
    return res.status(200).send({ user });
  }
}
`;
  }

  if (stack === 'hono') {
    return `// Purpose: Hono handlers for auth endpoints.

import type { Context } from 'hono';
import { AuthService, AuthError } from '${ctx.peer('service')}';
import { loginSchema, registerSchema } from '${ctx.peer('validator')}';

const service = new AuthService();

export class AuthController {
  async register(c: Context) {
    const input = registerSchema.parse(await c.req.json());
    const result = await service.register(input);
    return c.json(result, 201);
  }

  async login(c: Context) {
    try {
      const input = loginSchema.parse(await c.req.json());
      const result = await service.login(input);
      return c.json(result, 200);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ code: err.code, message: err.message }, 401);
      }
      throw err;
    }
  }

  async me(c: Context) {
    const user = c.get('user') as unknown;
    if (!user) return c.json({ code: 'INVALID_TOKEN', message: 'Not authenticated.' }, 401);
    return c.json({ user }, 200);
  }
}
`;
  }

  if (stack === 'nestjs') {
    return `// Purpose: NestJS controller for auth endpoints.

import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { AuthService, AuthError } from '${ctx.peer('service')}';
import { AuthGuard } from '${ctx.peer('guard')}';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '${ctx.peer('validator')}';
import type { PublicUser } from '${ctx.peer('types')}';

@Controller('auth')
export class AuthController {
  constructor(private readonly service: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() body: unknown) {
    const input = registerSchema.parse(body) satisfies RegisterInput;
    return this.service.register(input);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown) {
    try {
      const input = loginSchema.parse(body) satisfies LoginInput;
      return await this.service.login(input);
    } catch (err) {
      if (err instanceof AuthError) {
        throw new UnauthorizedException({ code: err.code, message: err.message });
      }
      throw err;
    }
  }

  @Get('me')
  @UseGuards(AuthGuard)
  me(@Req() req: { user?: PublicUser }) {
    return { user: req.user };
  }
}
`;
  }

  // Next.js App Router exports are generated separately (no controller class).
  return `// Purpose: Shared controller logic for Next.js auth route handlers.

import { AuthService, AuthError } from '${ctx.peer('service')}';
import { loginSchema, registerSchema } from '${ctx.peer('validator')}';

const service = new AuthService();

export async function handleRegister(body: unknown): Promise<{ status: number; body: unknown }> {
  const input = registerSchema.parse(body);
  const result = await service.register(input);
  return { status: 201, body: result };
}

export async function handleLogin(body: unknown): Promise<{ status: number; body: unknown }> {
  try {
    const input = loginSchema.parse(body);
    const result = await service.login(input);
    return { status: 200, body: result };
  } catch (err) {
    if (err instanceof AuthError) {
      return { status: 401, body: { code: err.code, message: err.message } };
    }
    throw err;
  }
}

export async function handleMe(authHeader: string | null): Promise<{ status: number; body: unknown }> {
  if (!authHeader?.startsWith('Bearer ')) {
    return { status: 401, body: { code: 'INVALID_TOKEN', message: 'Missing bearer token.' } };
  }
  try {
    const user = await service.introspect(authHeader.slice('Bearer '.length).trim());
    return { status: 200, body: { user } };
  } catch (err) {
    if (err instanceof AuthError) {
      return { status: 401, body: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
`;
}

export function authMiddlewareSource(config: PillarConfig, ctx: AuthTemplateContext): string {
  const stack = config.project.stack;

  if (stack === 'express') {
    return `// Purpose: Express middleware that verifies a Bearer JWT and attaches the user to req.user.

import type { Request, Response, NextFunction } from 'express';
import { AuthService, AuthError } from '${ctx.peer('service')}';

const service = new AuthService();

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ code: 'INVALID_TOKEN', message: 'Missing bearer token.' });
    return;
  }
  try {
    const user = await service.introspect(header.slice('Bearer '.length).trim());
    (req as Request & { user?: unknown }).user = user;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(401).json({ code: err.code, message: err.message });
      return;
    }
    next(err);
  }
}
`;
  }

  if (stack === 'fastify') {
    return `// Purpose: Fastify preHandler that verifies a Bearer JWT and attaches the user to request.

import type { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService, AuthError } from '${ctx.peer('service')}';

const service = new AuthService();

export async function authenticate(req: FastifyRequest, res: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    await res.status(401).send({ code: 'INVALID_TOKEN', message: 'Missing bearer token.' });
    return;
  }
  try {
    const user = await service.introspect(header.slice('Bearer '.length).trim());
    (req as FastifyRequest & { user?: unknown }).user = user;
  } catch (err) {
    if (err instanceof AuthError) {
      await res.status(401).send({ code: err.code, message: err.message });
      return;
    }
    throw err;
  }
}
`;
  }

  if (stack === 'hono') {
    return `// Purpose: Hono middleware that verifies a Bearer JWT and stores the user in the context.

import type { Context, Next } from 'hono';
import { AuthService, AuthError } from '${ctx.peer('service')}';

const service = new AuthService();

export async function authenticate(c: Context, next: Next): Promise<Response | void> {
  const header = c.req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return c.json({ code: 'INVALID_TOKEN', message: 'Missing bearer token.' }, 401);
  }
  try {
    const user = await service.introspect(header.slice('Bearer '.length).trim());
    c.set('user', user);
    await next();
  } catch (err) {
    if (err instanceof AuthError) {
      return c.json({ code: err.code, message: err.message }, 401);
    }
    throw err;
  }
}
`;
  }

  if (stack === 'nestjs') {
    return `// Purpose: NestJS guard that verifies a Bearer JWT and attaches the user to the request.

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService, AuthError } from '${ctx.peer('service')}';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly service: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    const header = req.headers['authorization'];
    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException({ code: 'INVALID_TOKEN', message: 'Missing bearer token.' });
    }
    try {
      req.user = await this.service.introspect(header.slice('Bearer '.length).trim());
      return true;
    } catch (err) {
      if (err instanceof AuthError) {
        throw new UnauthorizedException({ code: err.code, message: err.message });
      }
      throw err;
    }
  }
}
`;
  }

  // Next.js: a helper the route handler calls directly.
  return `// Purpose: Next.js helper that extracts + verifies the bearer token from a request.

import { AuthService, AuthError } from '${ctx.peer('service')}';
import type { PublicUser } from '${ctx.peer('types')}';

const service = new AuthService();

export async function authenticate(authorization: string | null): Promise<
  { ok: true; user: PublicUser } | { ok: false; status: number; body: { code: string; message: string } }
> {
  if (!authorization || !authorization.startsWith('Bearer ')) {
    return { ok: false, status: 401, body: { code: 'INVALID_TOKEN', message: 'Missing bearer token.' } };
  }
  try {
    const user = await service.introspect(authorization.slice('Bearer '.length).trim());
    return { ok: true, user };
  } catch (err) {
    if (err instanceof AuthError) {
      return { ok: false, status: 401, body: { code: err.code, message: err.message } };
    }
    throw err;
  }
}
`;
}

export function authRoutesSource(config: PillarConfig, ctx: AuthTemplateContext): string {
  const stack = config.project.stack;

  if (stack === 'express') {
    return `// Purpose: Wire the auth controller to HTTP verbs + paths (mounted at /auth by app.ts).

import { Router } from 'express';
import { AuthController } from '${ctx.peer('controller')}';
import { authenticate } from '${ctx.peer('middleware')}';

const router = Router();
const controller = new AuthController();

router.post('/register', (req, res, next) => controller.register(req, res, next));
router.post('/login', (req, res, next) => controller.login(req, res, next));
router.get('/me', authenticate, (req, res, next) => controller.me(req, res, next));

export { router as authRouter };
`;
  }

  if (stack === 'fastify') {
    return `// Purpose: Register auth routes against a Fastify instance.

import type { FastifyInstance } from 'fastify';
import { AuthController } from '${ctx.peer('controller')}';
import { authenticate } from '${ctx.peer('middleware')}';

const controller = new AuthController();

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', (req, res) => controller.register(req as never, res));
  app.post('/auth/login', (req, res) => controller.login(req as never, res));
  app.get('/auth/me', { preHandler: authenticate }, (req, res) => controller.me(req, res));
}
`;
  }

  if (stack === 'hono') {
    return `// Purpose: Hono sub-router exposing auth endpoints (mounted at /auth by app.ts).

import { Hono } from 'hono';
import { AuthController } from '${ctx.peer('controller')}';
import { authenticate } from '${ctx.peer('middleware')}';

const controller = new AuthController();
export const authRoutes = new Hono();

authRoutes.post('/register', (c) => controller.register(c));
authRoutes.post('/login', (c) => controller.login(c));
authRoutes.get('/me', authenticate, (c) => controller.me(c));
`;
  }

  // NestJS uses decorators; Next.js uses file-based handlers — neither gets a routes.ts.
  return '';
}

export function nestAuthModuleSource(_config: PillarConfig, ctx: AuthTemplateContext): string {
  return `// Purpose: NestJS auth module — wires the controller, service, and guard.

import { Module } from '@nestjs/common';
import { AuthController } from '${ctx.peer('controller')}';
import { AuthService } from '${ctx.peer('service')}';
import { AuthGuard } from '${ctx.peer('guard')}';

@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthGuard],
  exports: [AuthService, AuthGuard],
})
export class AuthModule {}
`;
}

/**
 * Next.js App Router handlers — one file per endpoint under `src/app/api/auth/`.
 * These import from the auth feature module via the `@/` alias, which
 * Next.js configures by default (baseUrl = 'src' in tsconfig).
 */
export function nextAuthRouteSource(
  endpoint: 'register' | 'login' | 'me',
  importPrefix: string,
): string {
  if (endpoint === 'register') {
    return `// Purpose: POST /api/auth/register handler.

import { NextResponse } from 'next/server';
import { handleRegister } from '${importPrefix}/auth.controller.js';

export async function POST(req: Request) {
  const result = await handleRegister(await req.json());
  return NextResponse.json(result.body, { status: result.status });
}
`;
  }
  if (endpoint === 'login') {
    return `// Purpose: POST /api/auth/login handler.

import { NextResponse } from 'next/server';
import { handleLogin } from '${importPrefix}/auth.controller.js';

export async function POST(req: Request) {
  const result = await handleLogin(await req.json());
  return NextResponse.json(result.body, { status: result.status });
}
`;
  }
  return `// Purpose: GET /api/auth/me — returns the authenticated user.

import { NextResponse } from 'next/server';
import { handleMe } from '${importPrefix}/auth.controller.js';

export async function GET(req: Request) {
  const result = await handleMe(req.headers.get('authorization'));
  return NextResponse.json(result.body, { status: result.status });
}
`;
}
