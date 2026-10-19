import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import { connectionIdSchema, noStore, parseBody, requireAuth, requirePermission } from '../http';
import { ENV_CONNECTION_ID } from '../services/connections';

const schemaQuery = z.object({ connectionId: connectionIdSchema.optional() }).strict();

const READY_TIMEOUT_MS = 2000;

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const { config, database, startedAt, metadata, connections, redact } = app.services;

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
    requirePermission(request, 'QUERY.SELECT');
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
    return {
      version: config.version,
      commit: config.commit,
      environment: config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt.getTime()) / 1000),
      database: { status: databaseStatus, kind: database.kind },
      sankhya: await connections.overview(),
      writes: {
        safeMode: config.safeMode,
        globalWriteEnabled: config.globalWriteEnabled,
        writeToSankhya: config.writeToSankhya,
        /** Mutations are not available yet: every write fails closed. */
        available: false,
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
