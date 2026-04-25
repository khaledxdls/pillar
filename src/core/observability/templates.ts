/**
 * Observability scaffold templates.
 *
 * Every stack gets the same five conceptual pieces — a pino logger,
 * request-scoped context (AsyncLocalStorage), request-id propagation,
 * structured HTTP access logging, and a centralised error handler —
 * but the wiring shape differs per stack. The shared pieces (logger,
 * request-context) are stack-agnostic; the middleware/handler files
 * branch on `Stack`.
 *
 * All templates are pure string functions of `(config, ctx)`. They
 * never touch the filesystem; the generator composes them and the
 * command writes them.
 */

import type { PillarConfig } from '../config/index.js';

export interface ObservabilityTemplateContext {
  /** Resolves a peer module specifier inside the observability dir. */
  peer: (suffix: string) => string;
}

type Stack = PillarConfig['project']['stack'];

// ---------------------------------------------------------------------------
// Shared (stack-agnostic) sources
// ---------------------------------------------------------------------------

export function loggerSource(_config: PillarConfig, ctx: ObservabilityTemplateContext): string {
  return `// Purpose: Application logger (pino) with request-scoped child binding.

import pino from 'pino';
import { getRequestContext } from ${q(ctx.peer('request-context'))};

const level = process.env['LOG_LEVEL'] ?? 'info';
const pretty = process.env['LOG_PRETTY'] === 'true';

const baseLogger = pino({
  level,
  base: { service: process.env['SERVICE_NAME'] ?? 'app' },
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
    censor: '[redacted]',
  },
  ...(pretty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' } } }
    : {}),
});

/**
 * Module-level logger. For request-scoped logs prefer \`logger()\` so the
 * current requestId is bound automatically.
 */
export const rootLogger = baseLogger;

/**
 * Returns a logger bound to the current request context (when invoked
 * inside a request) or the root logger otherwise. Always safe to call.
 */
export function logger(): pino.Logger {
  const ctx = getRequestContext();
  return ctx ? baseLogger.child({ requestId: ctx.requestId }) : baseLogger;
}
`;
}

export function requestContextSource(_config: PillarConfig): string {
  return `// Purpose: AsyncLocalStorage carrying per-request data (requestId).

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
`;
}

// ---------------------------------------------------------------------------
// Request-ID middleware (per stack)
// ---------------------------------------------------------------------------

export function requestIdSource(stack: Stack, ctx: ObservabilityTemplateContext): string {
  const ctxImport = `import { runWithRequestContext } from ${q(ctx.peer('request-context'))};`;
  const idImport = `import { randomUUID } from 'node:crypto';`;
  const HEADER = `'x-request-id'`;

  switch (stack) {
    case 'express':
      return `// Purpose: Express middleware — propagates X-Request-Id and binds AsyncLocalStorage.

${idImport}
import type { Request, Response, NextFunction } from 'express';
${ctxImport}

export function bindRequestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header('x-request-id');
    const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
    res.setHeader('x-request-id', id);
    runWithRequestContext({ requestId: id }, () => next());
  };
}
`;
    case 'fastify':
      return `// Purpose: Fastify plugin — propagates X-Request-Id and binds AsyncLocalStorage.

${idImport}
import type { FastifyInstance } from 'fastify';
${ctxImport}

export async function requestIdPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', (req, reply, done) => {
    const incoming = req.headers[${HEADER}];
    const raw = Array.isArray(incoming) ? incoming[0] : incoming;
    const id = raw && raw.length > 0 && raw.length <= 128 ? raw : randomUUID();
    void reply.header('x-request-id', id);
    runWithRequestContext({ requestId: id }, () => done());
  });
}
`;
    case 'hono':
      return `// Purpose: Hono middleware — propagates X-Request-Id and binds AsyncLocalStorage.

${idImport}
import type { MiddlewareHandler } from 'hono';
${ctxImport}

export function bindRequestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id');
    const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
    c.header('x-request-id', id);
    await runWithRequestContext({ requestId: id }, () => next());
  };
}
`;
    case 'nestjs':
      return `// Purpose: NestJS middleware — propagates X-Request-Id and binds AsyncLocalStorage.

${idImport}
import { Injectable, type NestMiddleware } from '@nestjs/common';
${ctxImport}

interface ReqLike { header(name: string): string | undefined; headers?: Record<string, string | string[] | undefined> }
interface ResLike { setHeader(name: string, value: string): void }

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: ReqLike, res: ResLike, next: () => void): void {
    const fromMethod = typeof req.header === 'function' ? req.header('x-request-id') : undefined;
    const raw = fromMethod ?? (req.headers?.['x-request-id'] as string | undefined);
    const id = raw && raw.length > 0 && raw.length <= 128 ? raw : randomUUID();
    res.setHeader('x-request-id', id);
    runWithRequestContext({ requestId: id }, () => next());
  }
}
`;
    case 'nextjs':
      return `// Purpose: Helper to derive/generate a request id inside Next.js route handlers.

${idImport}
${ctxImport}

export function deriveRequestId(req: Request): string {
  const incoming = req.headers.get('x-request-id');
  if (incoming && incoming.length > 0 && incoming.length <= 128) return incoming;
  return randomUUID();
}

export async function withRequestContext<T>(req: Request, fn: () => Promise<T>): Promise<{ id: string; value: T }> {
  const id = deriveRequestId(req);
  const value = await runWithRequestContext({ requestId: id }, () => fn());
  return { id, value };
}
`;
  }
}

// ---------------------------------------------------------------------------
// HTTP access logger middleware (per stack)
// ---------------------------------------------------------------------------

export function httpLoggerSource(stack: Stack, ctx: ObservabilityTemplateContext): string {
  const lImport = `import { logger } from ${q(ctx.peer('logger'))};`;

  switch (stack) {
    case 'express':
      return `// Purpose: Express middleware — emits structured request/response log lines.

import type { Request, Response, NextFunction } from 'express';
${lImport}

export function httpLogger() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      logger().info(
        { method: req.method, url: req.originalUrl, status: res.statusCode, durationMs: Math.round(durationMs) },
        'request completed',
      );
    });
    next();
  };
}
`;
    case 'fastify':
      return `// Purpose: Fastify plugin — emits structured request/response log lines.

import type { FastifyInstance } from 'fastify';
${lImport}

export async function httpLogger(app: FastifyInstance): Promise<void> {
  app.addHook('onResponse', (req, reply, done) => {
    logger().info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
    done();
  });
}
`;
    case 'hono':
      return `// Purpose: Hono middleware — emits structured request/response log lines.

import type { MiddlewareHandler } from 'hono';
${lImport}

export function httpLogger(): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now();
    await next();
    const durationMs = Math.round(performance.now() - start);
    logger().info(
      { method: c.req.method, url: c.req.url, status: c.res.status, durationMs },
      'request completed',
    );
  };
}
`;
    case 'nestjs':
      return `// Purpose: NestJS interceptor — emits structured request/response log lines.

import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
${lImport}

interface ReqLike { method?: string; url?: string; originalUrl?: string }
interface ResLike { statusCode?: number }

@Injectable()
export class HttpLoggerInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<ReqLike>();
    const res = http.getResponse<ResLike>();
    const start = process.hrtime.bigint();
    const url = req.originalUrl ?? req.url ?? '';
    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          logger().info(
            { method: req.method, url, status: res.statusCode, durationMs: Math.round(durationMs) },
            'request completed',
          );
        },
        error: () => {
          const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
          logger().warn(
            { method: req.method, url, durationMs: Math.round(durationMs) },
            'request errored',
          );
        },
      }),
    );
  }
}
`;
    case 'nextjs':
      return `// Purpose: Helper to wrap a Next.js handler with structured timing logs.

${lImport}

export async function withHttpLog<T>(req: Request, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const value = await fn();
    const durationMs = Math.round(performance.now() - start);
    logger().info({ method: req.method, url: req.url, durationMs }, 'request completed');
    return value;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    logger().warn({ method: req.method, url: req.url, durationMs }, 'request errored');
    throw err;
  }
}
`;
  }
}

// ---------------------------------------------------------------------------
// Error handler (per stack)
// ---------------------------------------------------------------------------

export function errorHandlerSource(stack: Stack, ctx: ObservabilityTemplateContext): string {
  const lImport = `import { logger } from ${q(ctx.peer('logger'))};`;
  const ctxImport = `import { getRequestContext } from ${q(ctx.peer('request-context'))};`;

  switch (stack) {
    case 'express':
      return `// Purpose: Express terminal error handler — logs and returns a structured JSON body.

import type { Request, Response, NextFunction } from 'express';
${lImport}
${ctxImport}

interface HttpishError extends Error { status?: number; statusCode?: number; }

export function errorHandler() {
  return (err: HttpishError, _req: Request, res: Response, _next: NextFunction): void => {
    const status = err.statusCode ?? err.status ?? 500;
    const requestId = getRequestContext()?.requestId;
    logger().error({ err, status, requestId }, err.message ?? 'unhandled error');
    if (res.headersSent) return;
    res.status(status).json({
      error: { message: status >= 500 ? 'Internal Server Error' : err.message, requestId },
    });
  };
}
`;
    case 'fastify':
      return `// Purpose: Fastify error handler — logs and returns a structured JSON body.

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
${lImport}
${ctxImport}

export async function errorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err: FastifyError, _req: FastifyRequest, reply: FastifyReply) => {
    const status = err.statusCode ?? 500;
    const requestId = getRequestContext()?.requestId;
    logger().error({ err, status, requestId }, err.message ?? 'unhandled error');
    void reply.status(status).send({
      error: { message: status >= 500 ? 'Internal Server Error' : err.message, requestId },
    });
  });
}
`;
    case 'hono':
      return `// Purpose: Hono error handler — logs and returns a structured JSON body.

import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
${lImport}
${ctxImport}

interface HttpishError extends Error { status?: number; statusCode?: number; }

export function attachErrorHandler(app: Hono): void {
  app.onError((err, c) => {
    const e = err as HttpishError;
    const status = (e.statusCode ?? e.status ?? 500) as ContentfulStatusCode;
    const requestId = getRequestContext()?.requestId;
    logger().error({ err, status, requestId }, err.message ?? 'unhandled error');
    return c.json(
      { error: { message: status >= 500 ? 'Internal Server Error' : err.message, requestId } },
      status,
    );
  });
}
`;
    case 'nestjs':
      return `// Purpose: NestJS catch-all exception filter — logs and returns a structured JSON body.

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
${lImport}
${ctxImport}

interface ResLike {
  headersSent?: boolean;
  status(code: number): { json(body: unknown): unknown };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<ResLike>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;
    const message =
      exception instanceof Error ? exception.message : 'unhandled error';
    const requestId = getRequestContext()?.requestId;
    logger().error({ err: exception, status, requestId }, message);
    if (res.headersSent) return;
    res.status(status).json({
      error: { message: status >= 500 ? 'Internal Server Error' : message, requestId },
    });
  }
}
`;
    case 'nextjs':
      return `// Purpose: Helper that turns thrown errors into structured JSON Responses.

${lImport}
${ctxImport}

interface HttpishError extends Error { status?: number; statusCode?: number; }

export function toErrorResponse(err: unknown): Response {
  const e = err as HttpishError;
  const status = e?.statusCode ?? e?.status ?? 500;
  const requestId = getRequestContext()?.requestId;
  const message = e instanceof Error ? e.message : 'unhandled error';
  logger().error({ err, status, requestId }, message);
  return Response.json(
    { error: { message: status >= 500 ? 'Internal Server Error' : message, requestId } },
    { status },
  );
}
`;
  }
}

// ---------------------------------------------------------------------------
// Health controller / routes (per stack)
// ---------------------------------------------------------------------------

export function healthSource(stack: Stack, _ctx: ObservabilityTemplateContext): string {
  switch (stack) {
    case 'express':
      return `// Purpose: Express router exposing GET /health (liveness) and GET /ready (readiness).

import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

healthRouter.get('/ready', (_req, res) => {
  res.json({ status: 'ready', timestamp: new Date().toISOString() });
});
`;
    case 'fastify':
      return `// Purpose: Fastify plugin exposing GET /health (liveness) and GET /ready (readiness).

import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));
  app.get('/ready', async () => ({
    status: 'ready',
    timestamp: new Date().toISOString(),
  }));
}
`;
    case 'hono':
      return `// Purpose: Hono sub-app exposing GET /health (liveness) and GET /ready (readiness).

import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/health', (c) =>
  c.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() }),
);

healthRoutes.get('/ready', (c) =>
  c.json({ status: 'ready', timestamp: new Date().toISOString() }),
);
`;
    case 'nestjs':
      return `// Purpose: NestJS controller exposing GET /health and GET /ready.

import { Controller, Get } from '@nestjs/common';

@Controller()
export class HealthController {
  @Get('health')
  health(): { status: string; uptime: number; timestamp: string } {
    return { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() };
  }

  @Get('ready')
  ready(): { status: string; timestamp: string } {
    return { status: 'ready', timestamp: new Date().toISOString() };
  }
}
`;
    case 'nextjs':
      // NestJS-of-Next: emitted from generator into src/app/api/health|ready/route.ts
      return '';
  }
}

// ---------------------------------------------------------------------------
// NestJS observability module
// ---------------------------------------------------------------------------

export function nestObservabilityModuleSource(_config: PillarConfig, ctx: ObservabilityTemplateContext): string {
  return `// Purpose: NestJS module wiring HealthController + interceptor + global filter + middleware.

import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HealthController } from ${q(ctx.peer('health'))};
import { HttpLoggerInterceptor } from ${q(ctx.peer('http-logger'))};
import { AllExceptionsFilter } from ${q(ctx.peer('error-handler'))};
import { RequestIdMiddleware } from ${q(ctx.peer('request-id'))};

@Module({
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: HttpLoggerInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
`;
}

// ---------------------------------------------------------------------------
// Next.js route handlers (file-per-route)
// ---------------------------------------------------------------------------

export function nextHealthRouteSource(importPrefix: string, kind: 'health' | 'ready'): string {
  return `// Purpose: Next.js App Router handler for GET /api/${kind}.

import { withRequestContext } from '${importPrefix}/request-id.js';
import { withHttpLog } from '${importPrefix}/http-logger.js';
import { toErrorResponse } from '${importPrefix}/error-handler.js';

export async function GET(req: Request): Promise<Response> {
  try {
    const { id, value } = await withRequestContext(req, () =>
      withHttpLog(req, async () => ({
        status: '${kind === 'health' ? 'ok' : 'ready'}',
        ${kind === 'health' ? 'uptime: process.uptime(),\n        ' : ''}timestamp: new Date().toISOString(),
      })),
    );
    return Response.json(value, { headers: { 'x-request-id': id } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function q(s: string): string {
  return `'${s}'`;
}
