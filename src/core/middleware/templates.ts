import type { PillarConfig } from '../config/index.js';
import type { Stack } from '../../utils/constants.js';

/**
 * Stack- and kind-aware source templates for the middleware scaffold.
 *
 * Each supported kind (cors, rate-limit, helmet, request-id) emits a single
 * middleware file under `src/middleware/<kind>.middleware.ts`. Templates
 * assume TypeScript (generator rejects JS projects) and use ESM `.js`
 * import suffixes to stay compatible with Node16 module resolution.
 */

export type MiddlewareKind = 'cors' | 'rate-limit' | 'helmet' | 'request-id';

export const SUPPORTED_MIDDLEWARE_KINDS: readonly MiddlewareKind[] = [
  'cors',
  'rate-limit',
  'helmet',
  'request-id',
] as const;

export interface MiddlewareEnvKey {
  key: string;
  defaultValue: string;
  comment: string;
}

export interface MiddlewareEmission {
  /** Source of `src/middleware/<kind>.middleware.ts`. */
  source: string;
  /** Runtime deps to add to package.json. */
  dependencies: Record<string, string>;
  /** Dev deps (e.g. @types/cors). */
  devDependencies: Record<string, string>;
  /** Env keys to add to `.env` and `.env.example`. */
  envKeys: MiddlewareEnvKey[];
  /**
   * What the app-entry wiring looks like. The command layer uses this to
   * idempotently splice imports + a registration statement into app.ts
   * (or main.ts for NestJS). `null` means this stack gets no auto-wiring
   * — the user is expected to opt in manually.
   */
  wiring: MiddlewareWiring | null;
}

export interface MiddlewareWiring {
  /** Named import binding from the middleware file (e.g. `corsOptions`, `rateLimiter`). */
  importBinding: string;
  /**
   * The exact statement to inject. Express/Hono go at module scope (before
   * the last export); Fastify must be injected inside the factory body;
   * NestJS goes into `main.ts` inside the bootstrap async function.
   */
  statement: string;
  /** Where the statement belongs. */
  target: 'app-module-scope' | 'fastify-factory-body' | 'nest-bootstrap-body';
}

/**
 * Build the file emission + deps for a given (kind, stack) combination.
 * Thin dispatch — the bodies live in kind-specific helpers below.
 */
export function buildMiddleware(
  kind: MiddlewareKind,
  config: PillarConfig,
): MiddlewareEmission {
  switch (kind) {
    case 'cors':         return corsEmission(config);
    case 'rate-limit':   return rateLimitEmission(config);
    case 'helmet':       return helmetEmission(config);
    case 'request-id':   return requestIdEmission(config);
  }
}

// ---------------------------------------------------------------------------
// cors
// ---------------------------------------------------------------------------

function corsEmission(config: PillarConfig): MiddlewareEmission {
  const stack = config.project.stack;
  const envKeys: MiddlewareEnvKey[] = [
    {
      key: 'CORS_ORIGIN',
      defaultValue: '*',
      comment: 'Comma-separated list of allowed origins, or "*" for any. Never use "*" in production with credentials.',
    },
  ];

  if (stack === 'express') {
    return {
      source: expressCorsSource(),
      dependencies: { cors: '^2.8.5' },
      devDependencies: { '@types/cors': '^2.8.17' },
      envKeys,
      wiring: { importBinding: 'corsMiddleware', statement: `app.use(corsMiddleware());`, target: 'app-module-scope' },
    };
  }

  if (stack === 'nestjs') {
    // NestJS ships its own CORS support via `app.enableCors(options)` — no
    // need to pull in the `cors` package. Emitting a plain options object
    // avoids the `cors`-vs-`@nestjs/common` CorsOptions type mismatch that
    // surfaces when the two declarations of `origin` don't line up.
    return {
      source: nestCorsSource(),
      dependencies: {},
      devDependencies: {},
      envKeys,
      wiring: { importBinding: 'corsOptions', statement: `app.enableCors(corsOptions);`, target: 'nest-bootstrap-body' },
    };
  }

  if (stack === 'fastify') {
    return {
      source: fastifyCorsSource(),
      dependencies: { '@fastify/cors': '^9.0.1' },
      devDependencies: {},
      envKeys,
      wiring: {
        importBinding: 'registerCors',
        statement: `  await registerCors(app);`,
        target: 'fastify-factory-body',
      },
    };
  }

  if (stack === 'hono') {
    return {
      source: honoCorsSource(),
      dependencies: {},
      devDependencies: {},
      envKeys,
      wiring: {
        importBinding: 'corsMiddleware',
        statement: `app.use('*', corsMiddleware);`,
        target: 'app-module-scope',
      },
    };
  }

  // Next.js — emit a helper; no auto-wiring (edge middleware composition is left to the user).
  return {
    source: nextCorsSource(),
    dependencies: {},
    devDependencies: {},
    envKeys,
    wiring: null,
  };
}

function expressCorsSource(): string {
  return `// Purpose: CORS configuration for the HTTP server — origin list is driven by CORS_ORIGIN env.

import cors, { type CorsOptions } from 'cors';

function parseOrigins(): CorsOptions['origin'] {
  const raw = process.env['CORS_ORIGIN'] ?? '*';
  if (raw === '*') return true;
  const list = raw.split(',').map((o) => o.trim()).filter(Boolean);
  if (list.length === 0) return false;
  return (origin, cb) => {
    if (!origin || list.includes(origin)) return cb(null, true);
    cb(new Error('Origin not allowed by CORS'), false);
  };
}

export const corsOptions: CorsOptions = {
  origin: parseOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};

export function corsMiddleware() {
  return cors(corsOptions);
}
`;
}

function fastifyCorsSource(): string {
  return `// Purpose: CORS registration for Fastify — origin list is driven by CORS_ORIGIN env.

import type { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';

function parseOrigins(): true | string[] {
  const raw = process.env['CORS_ORIGIN'] ?? '*';
  if (raw === '*') return true;
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export async function registerCors(app: FastifyInstance): Promise<void> {
  await app.register(fastifyCors, {
    origin: parseOrigins(),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400,
  });
}
`;
}

function honoCorsSource(): string {
  return `// Purpose: Hono CORS middleware — origin list is driven by CORS_ORIGIN env.

import { cors } from 'hono/cors';

function parseOrigins(): string | string[] {
  const raw = process.env['CORS_ORIGIN'] ?? '*';
  if (raw === '*') return '*';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export const corsMiddleware = cors({
  origin: parseOrigins(),
  credentials: true,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
});
`;
}

function nestCorsSource(): string {
  return `// Purpose: CORS configuration for NestJS — origin list is driven by CORS_ORIGIN env.

function parseOrigins(): boolean | string[] {
  const raw = process.env['CORS_ORIGIN'] ?? '*';
  if (raw === '*') return true;
  const list = raw.split(',').map((o) => o.trim()).filter(Boolean);
  return list.length > 0 ? list : false;
}

/** Pass this to \`app.enableCors(corsOptions)\` in main.ts. */
export const corsOptions = {
  origin: parseOrigins(),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
};
`;
}

function nextCorsSource(): string {
  return `// Purpose: CORS header helper for Next.js route handlers / edge middleware.

function parseOrigins(): '*' | string[] {
  const raw = process.env['CORS_ORIGIN'] ?? '*';
  if (raw === '*') return '*';
  return raw.split(',').map((o) => o.trim()).filter(Boolean);
}

export function applyCorsHeaders(origin: string | null, headers: Headers): void {
  const allowed = parseOrigins();
  const allow = allowed === '*' ? '*' : (origin && allowed.includes(origin) ? origin : '');
  if (!allow) return;
  headers.set('Access-Control-Allow-Origin', allow);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
}
`;
}

// ---------------------------------------------------------------------------
// rate-limit
// ---------------------------------------------------------------------------

function rateLimitEmission(config: PillarConfig): MiddlewareEmission {
  const stack = config.project.stack;
  const envKeys: MiddlewareEnvKey[] = [
    { key: 'RATE_LIMIT_WINDOW_MS', defaultValue: '60000', comment: 'Rolling window length in milliseconds (default 1 min).' },
    { key: 'RATE_LIMIT_MAX',       defaultValue: '100',   comment: 'Maximum requests per IP per window.' },
  ];

  if (stack === 'express' || stack === 'nestjs') {
    return {
      source: expressRateLimitSource(),
      dependencies: { 'express-rate-limit': '^7.4.0' },
      devDependencies: {},
      envKeys,
      wiring: stack === 'express'
        ? { importBinding: 'rateLimiter', statement: `app.use(rateLimiter);`, target: 'app-module-scope' }
        : { importBinding: 'rateLimiter', statement: `app.use(rateLimiter);`, target: 'nest-bootstrap-body' },
    };
  }

  if (stack === 'fastify') {
    return {
      source: fastifyRateLimitSource(),
      dependencies: { '@fastify/rate-limit': '^9.1.0' },
      devDependencies: {},
      envKeys,
      wiring: {
        importBinding: 'registerRateLimit',
        statement: `  await registerRateLimit(app);`,
        target: 'fastify-factory-body',
      },
    };
  }

  if (stack === 'hono') {
    return {
      source: honoRateLimitSource(),
      dependencies: { 'hono-rate-limiter': '^0.4.2' },
      devDependencies: {},
      envKeys,
      wiring: {
        importBinding: 'rateLimiter',
        statement: `app.use('*', rateLimiter);`,
        target: 'app-module-scope',
      },
    };
  }

  return {
    source: nextRateLimitSource(),
    dependencies: {},
    devDependencies: {},
    envKeys,
    wiring: null,
  };
}

function expressRateLimitSource(): string {
  return `// Purpose: Per-IP request rate limiting — window + max are driven by RATE_LIMIT_* env.

import rateLimit from 'express-rate-limit';

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const rateLimiter = rateLimit({
  windowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
  limit: readInt('RATE_LIMIT_MAX', 100),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { code: 'RATE_LIMITED', message: 'Too many requests — please slow down.' },
});
`;
}

function fastifyRateLimitSource(): string {
  return `// Purpose: Per-IP rate limiting for Fastify — window + max are driven by RATE_LIMIT_* env.

import type { FastifyInstance } from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(fastifyRateLimit, {
    max: readInt('RATE_LIMIT_MAX', 100),
    timeWindow: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
    errorResponseBuilder: () => ({ code: 'RATE_LIMITED', message: 'Too many requests — please slow down.' }),
  });
}
`;
}

function honoRateLimitSource(): string {
  return `// Purpose: Per-IP rate limiting for Hono — window + max are driven by RATE_LIMIT_* env.

import { rateLimiter as createRateLimiter } from 'hono-rate-limiter';

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const rateLimiter = createRateLimiter({
  windowMs: readInt('RATE_LIMIT_WINDOW_MS', 60_000),
  limit: readInt('RATE_LIMIT_MAX', 100),
  standardHeaders: 'draft-7',
  keyGenerator: (c) =>
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'global',
  handler: (c) =>
    c.json({ code: 'RATE_LIMITED', message: 'Too many requests — please slow down.' }, 429),
});
`;
}

function nextRateLimitSource(): string {
  return `// Purpose: In-memory token-bucket rate limiter for Next.js route handlers / edge middleware.
// Replace the Map with a shared store (Redis/Upstash) before running in a multi-instance deployment.

interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  const windowMs = readInt('RATE_LIMIT_WINDOW_MS', 60_000);
  const max = readInt('RATE_LIMIT_MAX', 100);

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const fresh: Bucket = { count: 1, resetAt: now + windowMs };
    buckets.set(key, fresh);
    return { allowed: true, remaining: max - 1, resetAt: fresh.resetAt };
  }

  if (existing.count >= max) {
    return { allowed: false, remaining: 0, resetAt: existing.resetAt };
  }
  existing.count += 1;
  return { allowed: true, remaining: max - existing.count, resetAt: existing.resetAt };
}
`;
}

// ---------------------------------------------------------------------------
// helmet
// ---------------------------------------------------------------------------

function helmetEmission(config: PillarConfig): MiddlewareEmission {
  const stack = config.project.stack;

  if (stack === 'express' || stack === 'nestjs') {
    return {
      source: expressHelmetSource(),
      dependencies: { helmet: '^8.0.0' },
      devDependencies: {},
      envKeys: [],
      wiring: stack === 'express'
        ? { importBinding: 'securityHeaders', statement: `app.use(securityHeaders());`, target: 'app-module-scope' }
        : { importBinding: 'securityHeaders', statement: `app.use(securityHeaders());`, target: 'nest-bootstrap-body' },
    };
  }

  if (stack === 'fastify') {
    return {
      source: fastifyHelmetSource(),
      dependencies: { '@fastify/helmet': '^12.0.0' },
      devDependencies: {},
      envKeys: [],
      wiring: {
        importBinding: 'registerSecurityHeaders',
        statement: `  await registerSecurityHeaders(app);`,
        target: 'fastify-factory-body',
      },
    };
  }

  if (stack === 'hono') {
    return {
      source: honoHelmetSource(),
      dependencies: {},
      devDependencies: {},
      envKeys: [],
      wiring: {
        importBinding: 'securityHeaders',
        statement: `app.use('*', securityHeaders);`,
        target: 'app-module-scope',
      },
    };
  }

  return {
    source: nextHelmetSource(),
    dependencies: {},
    devDependencies: {},
    envKeys: [],
    wiring: null,
  };
}

function expressHelmetSource(): string {
  return `// Purpose: Secure HTTP headers (CSP, HSTS, X-Frame-Options, etc.) via helmet.

import helmet from 'helmet';

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}
`;
}

function fastifyHelmetSource(): string {
  return `// Purpose: Secure HTTP headers for Fastify via @fastify/helmet.

import type { FastifyInstance } from 'fastify';
import fastifyHelmet from '@fastify/helmet';

export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
  await app.register(fastifyHelmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}
`;
}

function honoHelmetSource(): string {
  return `// Purpose: Minimal security-headers middleware for Hono (helmet has no first-party port).

import type { Context, Next } from 'hono';

const HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-DNS-Prefetch-Control': 'off',
  'X-Download-Options': 'noopen',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

export async function securityHeaders(c: Context, next: Next): Promise<void> {
  await next();
  for (const [k, v] of Object.entries(HEADERS)) {
    c.res.headers.set(k, v);
  }
}
`;
}

function nextHelmetSource(): string {
  return `// Purpose: Security-header helper for Next.js route handlers / edge middleware.

const HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; frame-ancestors 'none'",
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export function applySecurityHeaders(headers: Headers): void {
  for (const [k, v] of Object.entries(HEADERS)) {
    headers.set(k, v);
  }
}
`;
}

// ---------------------------------------------------------------------------
// request-id
// ---------------------------------------------------------------------------

function requestIdEmission(config: PillarConfig): MiddlewareEmission {
  const stack = config.project.stack;

  if (stack === 'express') {
    return {
      source: expressRequestIdSource(),
      dependencies: {},
      devDependencies: {},
      envKeys: [],
      wiring: { importBinding: 'requestId', statement: `app.use(requestId());`, target: 'app-module-scope' },
    };
  }

  if (stack === 'nestjs') {
    // NestJS projects don't have `@types/express` as a direct dep, so we
    // emit a structurally-typed middleware that doesn't import from 'express'.
    // Still Express-compatible (that's what Nest uses under the hood).
    return {
      source: nestRequestIdSource(),
      dependencies: {},
      devDependencies: {},
      envKeys: [],
      wiring: { importBinding: 'requestId', statement: `app.use(requestId());`, target: 'nest-bootstrap-body' },
    };
  }

  if (stack === 'fastify') {
    return {
      source: fastifyRequestIdSource(),
      dependencies: {},
      devDependencies: {},
      envKeys: [],
      wiring: {
        importBinding: 'registerRequestId',
        statement: `  await registerRequestId(app);`,
        target: 'fastify-factory-body',
      },
    };
  }

  if (stack === 'hono') {
    return {
      source: honoRequestIdSource(),
      dependencies: {},
      devDependencies: {},
      envKeys: [],
      wiring: {
        importBinding: 'requestId',
        statement: `app.use('*', requestId);`,
        target: 'app-module-scope',
      },
    };
  }

  return {
    source: nextRequestIdSource(),
    dependencies: {},
    devDependencies: {},
    envKeys: [],
    wiring: null,
  };
}

const REQUEST_ID_HEADER = 'x-request-id';

function expressRequestIdSource(): string {
  return `// Purpose: Attach a correlation ID to every request (honors inbound ${REQUEST_ID_HEADER}).

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.headers['${REQUEST_ID_HEADER}'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    (req as Request & { id?: string }).id = id;
    res.setHeader('${REQUEST_ID_HEADER}', id);
    next();
  };
}
`;
}

function nestRequestIdSource(): string {
  return `// Purpose: Attach a correlation ID to every request (honors inbound ${REQUEST_ID_HEADER}).
// Structurally typed so this compiles without @types/express as a direct dep.

import { randomUUID } from 'node:crypto';

interface ReqLike {
  headers: Record<string, string | string[] | undefined>;
  id?: string;
}
interface ResLike {
  setHeader(name: string, value: string): void;
}
type NextFn = (err?: unknown) => void;

export function requestId() {
  return (req: ReqLike, res: ResLike, next: NextFn): void => {
    const incoming = req.headers['${REQUEST_ID_HEADER}'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    req.id = id;
    res.setHeader('${REQUEST_ID_HEADER}', id);
    next();
  };
}
`;
}

function fastifyRequestIdSource(): string {
  return `// Purpose: Attach a correlation ID to every Fastify request (honors inbound ${REQUEST_ID_HEADER}).

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';

export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req, res) => {
    const incoming = req.headers['${REQUEST_ID_HEADER}'];
    const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : randomUUID();
    (req as typeof req & { id: string }).id = id;
    void res.header('${REQUEST_ID_HEADER}', id);
  });
}
`;
}

function honoRequestIdSource(): string {
  return `// Purpose: Attach a correlation ID to every Hono request (honors inbound ${REQUEST_ID_HEADER}).

import type { Context, Next } from 'hono';
import { randomUUID } from 'node:crypto';

export async function requestId(c: Context, next: Next): Promise<void> {
  const incoming = c.req.header('${REQUEST_ID_HEADER}');
  const id = incoming && incoming.length > 0 ? incoming : randomUUID();
  c.set('requestId', id);
  await next();
  c.res.headers.set('${REQUEST_ID_HEADER}', id);
}
`;
}

function nextRequestIdSource(): string {
  return `// Purpose: Derive a correlation ID for a Next.js request (honors inbound ${REQUEST_ID_HEADER}).

import { randomUUID } from 'node:crypto';

export function resolveRequestId(req: Request): string {
  const incoming = req.headers.get('${REQUEST_ID_HEADER}');
  return incoming && incoming.length > 0 ? incoming : randomUUID();
}

export const REQUEST_ID_HEADER = '${REQUEST_ID_HEADER}';
`;
}

/** Internal escape-hatch for the generator to surface "stack not supported" cleanly. */
export function isStackSupported(_stack: Stack): true {
  return true;
}
