import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import {
  clientIp,
  connectionIdSchema,
  noStore,
  parseBody,
  requireAuth,
  requirePermission,
} from '../http';
import { ENV_CONNECTION_ID } from '../services/connections';
import { authorizeConnection, connectionDenied } from '../services/read-policy';

const schemaQuery = z.object({ connectionId: connectionIdSchema.optional() }).strict();

const READY_TIMEOUT_MS = 2000;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const {
    config,
    database,
    startedAt,
    metadata,
    connections,
    redact,
    policies,
    authz,
    audit,
    security,
  } = app.services;

  // Probes hit these every few seconds; keep them out of the info-level request log.
  const probe = { logLevel: 'warn' } as const;

  app.get('/health/live', probe, async () => ({ status: 'ok' }));

  app.get('/health/ready', probe, async (_request, reply) => {
    const checks: Record<string, 'ok' | 'error'> = { database: 'ok' };
    let timer: NodeJS.Timeout | undefined;
    try {
      // A hung database must read as not ready, not hang the probe.
      await Promise.race([
        database.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('ping timeout')), READY_TIMEOUT_MS);
        }),
      ]);
    } catch {
      checks.database = 'error';
    } finally {
      if (timer) clearTimeout(timer);
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    void reply.code(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'error', checks };
  });

  /** Public, minimal: what the login page and footer need. */
  app.get('/api/meta', async () => ({
    name: 'DB-Sankhya',
    version: config.version,
    commit: config.commit,
    sankhyaMode: config.sankhya.mode,
    /** DEMO_MODE: fictitious data only; the UI shows a permanent DEMO banner. */
    demoMode: config.demoMode,
  }));

  app.get('/api/schema', async (request, reply) => {
    const auth = requirePermission(request, 'QUERY.SELECT');
    const { connectionId: requested } = parseBody(schemaQuery, request.query);
    let connectionId = requested;
    if (connectionId === undefined) {
      if (!config.sankhya.envConnection) {
        throw new AppError(
          'VALIDATION_ERROR',
          'connectionId is required: no default Sankhya connection is configured',
        );
      }
      connectionId = ENV_CONNECTION_ID;
    }
    // The catalog is only loaded for a connection the policy lets this user read; an unknown
    // connection gets the same answer as a denied one.
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds: await authz.activeGroupIds(auth.user.id),
      action: 'QUERY.SELECT',
      connectionId,
      connections,
    });
    if (!access.ok) {
      const err = connectionDenied();
      await audit.record({
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
        action: 'read.denied',
        status: 'denied',
        operation: 'SCHEMA',
        resource: null,
        errorCode: err.code,
        errorMessage: err.message,
        details: { connectionId, reasons: access.reasons },
      });
      throw err;
    }
    noStore(reply);
    return redact({ connectionId, catalog: await metadata.get(connectionId) });
  });

  app.get('/api/status', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    let databaseStatus: 'ok' | 'error' = 'ok';
    try {
      await database.ping();
    } catch {
      databaseStatus = 'error';
    }
    // The same switches /api/query/execute checks (it re-checks them itself on every execute).
    const globalWrite = await security.globalWriteState();
    const sankhyaWrites = globalWrite.effective && config.writeToSankhya;
    return {
      version: config.version,
      commit: config.commit,
      environment: config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      database: { status: databaseStatus, kind: database.kind },
      sankhya: await connections.overview(),
      writes: {
        safeMode: config.safeMode,
        /** Effective kill switch: env GLOBAL_WRITE_ENABLED AND the runtime switch. */
        globalWriteEnabled: globalWrite.effective,
        globalWrite,
        writeToSankhya: config.writeToSankhya,
        /** Sankhya writes pass the switches (on PRODUCTION connections only with SAFE_MODE off). */
        available: sankhyaWrites,
        /** Sankhya writes pass the switches on PRODUCTION connections too. */
        productionAvailable: sankhyaWrites && !config.safeMode,
        /** Scratch writes only need the global switch. */
        scratchAvailable: globalWrite.effective,
      },
      limits: {
        maxRows: config.sankhya.maxRows,
        timeoutMs: config.sankhya.timeoutMs,
      },
      roles: auth.grants.roles,
      permissions: [...auth.grants.permissions].sort(),
    };
  });
}
