import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import type { FastifyError, FastifyInstance, FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { AppError, createRedactor, isAppError, toErrorPayload } from '@dbx/shared';
import type { DatabaseHandle } from '@dbx/database';
import type { AppConfig } from './config';
import { secretValues } from './config';
import type { AppServices } from './context';
import { loggerOptions } from './logger';
import { ConnectionsService } from './services/connections';
import type { ConnectionsDeps } from './services/connections';
import { ExecutionRegistry } from './services/executions';
import { MetadataService } from './services/metadata';
import { PolicyService } from './services/policy';
import { AuditService, HistoryService, SavedQueriesService } from './services/records';
import { SessionsService } from './services/sessions';
import { UsersService } from './services/users';
import { AuthzService } from './services/authz';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { dataRoutes } from './routes/data';
import { queryRoutes } from './routes/query';
import { systemRoutes } from './routes/system';

export interface BuildAppOptions {
  config: AppConfig;
  database: DatabaseHandle;
  /** Sankhya hooks: DNS stub and fake gateway fetch. */
  sankhya?: ConnectionsDeps;
  logger?: FastifyServerOptions['logger'];
}

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PASSWORD_CHANGE_ALLOWED = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/meta',
]);

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config, database } = options;
  const app = Fastify({
    logger: options.logger ?? loggerOptions(config.logLevel, secretValues(config)),
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    },
    routerOptions: { maxParamLength: 200 },
  });

  const redactor = createRedactor(secretValues(config));
  const authz = new AuthzService(database.db);
  const connections = new ConnectionsService(database.db, config, options.sankhya);
  const services: AppServices = {
    config,
    database,
    users: new UsersService(database.db, authz),
    authz,
    sessions: new SessionsService(database.db, config.session.hours),
    audit: new AuditService(database.db, redactor),
    history: new HistoryService(database.db),
    saved: new SavedQueriesService(database.db),
    connections,
    metadata: new MetadataService(database.db, { getRuntime: (id) => connections.getRuntime(id) }),
    policies: new PolicyService(database.db, app.log),
    redact: redactor,
    executions: new ExecutionRegistry(),
    startedAt: new Date(),
  };
  app.decorate('services', services);
  app.decorateRequest('auth', null);

  // JSON only: no text/plain or form bodies, which also blocks "simple request" CSRF.
  app.removeContentTypeParser(['text/plain']);

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url.startsWith('/health/'),
    errorResponseBuilder: (_req, ctx) =>
      new AppError(
        'RATE_LIMITED',
        `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
        {
          retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
        },
      ),
  });

  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    if (!request.url.startsWith('/api/')) return;
    // CSRF: state-changing API requests must come from our own origin (plus SameSite=Strict cookies).
    if (!SAFE_METHODS.has(request.method)) {
      const origin = request.headers.origin ?? refererOrigin(request.headers.referer);
      if (!origin || !config.trustedOrigins.includes(origin))
        throw new AppError('CSRF_REJECTED', 'Cross-origin request rejected');
    }
    const token = request.cookies[config.session.cookieName];
    if (token) {
      const resolved = await services.sessions.resolve(token);
      if (resolved) request.auth = { ...resolved, grants: await authz.grants(resolved.user.id) };
      else void reply.clearCookie(config.session.cookieName, { path: '/' });
    }
    // Accounts created or reset by an admin must set their own password before anything else.
    if (
      request.auth?.user.mustChangePassword &&
      !PASSWORD_CHANGE_ALLOWED.has(request.routeOptions.url ?? '')
    ) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED', 'Change your password to continue');
    }
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    let appError: unknown = error;
    if (!isAppError(error)) {
      const fe = error as FastifyError;
      if (fe.validation) appError = new AppError('VALIDATION_ERROR', 'Invalid request');
      else if (fe.statusCode === 415)
        appError = new AppError('VALIDATION_ERROR', 'Content-Type must be application/json');
      else if (fe.statusCode === 413)
        appError = new AppError('VALIDATION_ERROR', 'Request body too large');
      else if (fe.statusCode === 400 && fe.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
        appError = new AppError('VALIDATION_ERROR', 'Malformed JSON body');
      } else if (fe.statusCode === 400) appError = new AppError('VALIDATION_ERROR', 'Bad request');
    }
    const status = isAppError(appError) ? appError.status : 500;
    if (status >= 500 && !isAppError(appError))
      request.log.error({ err: error }, 'unhandled error');
    else if (status >= 500)
      request.log.warn({ code: (appError as AppError).code }, (appError as AppError).message);
    const payload = toErrorPayload(appError, request.id);
    if (isAppError(appError) && appError.code === 'RATE_LIMITED') {
      const retry = appError.details?.retryAfterSeconds;
      if (typeof retry === 'number') void reply.header('retry-after', String(retry));
    }
    void reply.code(status).send(redactor(payload));
  });

  await app.register(systemRoutes);
  await app.register(authRoutes);
  await app.register(queryRoutes);
  await app.register(dataRoutes);
  await app.register(adminRoutes);

  const staticDir = config.staticDir ? resolve(config.staticDir) : undefined;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false,
      index: ['index.html'],
      setHeaders: (res, path) => {
        void res.header(
          'cache-control',
          /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache',
        );
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/api/') || request.url.startsWith('/health/');
    if (
      !isApi &&
      staticDir &&
      request.method === 'GET' &&
      existsSync(resolve(staticDir, 'index.html'))
    ) {
      void reply.header('cache-control', 'no-cache');
      return reply.sendFile('index.html');
    }
    void reply
      .code(404)
      .send(toErrorPayload(new AppError('NOT_FOUND', 'Route not found'), request.id));
  });

  app.addHook('onClose', async () => {
    services.executions.abortAll();
    await services.connections.close();
  });
  return app;
}

function refererOrigin(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}
