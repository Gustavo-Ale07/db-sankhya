import type { FastifyInstance, FastifyRequest } from 'fastify';
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
import type { Catalog, CatalogTable } from '../services/metadata';
import { authorizeConnection, connectionDenied, visibleCatalog } from '../services/read-policy';

const schemaQuery = z.object({ connectionId: connectionIdSchema.optional() }).strict();
const tableParams = z.object({ name: z.string().min(1).max(128) }).strict();

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

  /**
   * Who reads the catalog of which connection: QUERY.SELECT and a connection the policy lets the
   * user read. An unknown connection gets the same answer as a denied one, and is audited.
   */
  async function schemaAccess(request: FastifyRequest) {
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
    const groupIds = await authz.activeGroupIds(auth.user.id);
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds,
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
    return {
      auth,
      connectionId,
      // Only the tables and columns this user may read are listed (names are disclosure too).
      visible: (catalog: Catalog) =>
        visibleCatalog(
          { policies, auth, groupIds, environment: access.environment, connectionId },
          catalog,
          (err) => request.log.error({ err }, 'Catalog policy filter failed: serving no table'),
        ),
    };
  }

  app.get('/api/schema', async (request, reply) => {
    const { connectionId, visible } = await schemaAccess(request);
    const catalog = await visible(await metadata.get(connectionId));
    noStore(reply);
    return redact({ connectionId, catalog });
  });

  /**
   * Reads the whole catalog again now (e.g. after it came back incomplete). Each refresh reads the
   * whole dictionary from the gateway, so it is rate limited, and audited.
   */
  app.post(
    '/api/schema/refresh',
    { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { auth, connectionId, visible } = await schemaAccess(request);
      const entry = {
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
        action: 'schema.refresh',
        operation: 'SCHEMA',
        resource: null,
      } as const;
      let catalog: Catalog;
      try {
        catalog = await metadata.get(connectionId, { refresh: true });
      } catch (err) {
        const e = err instanceof AppError ? err : undefined;
        await audit.record({
          ...entry,
          status: 'failed',
          errorCode: e?.code ?? 'INTERNAL_ERROR',
          errorMessage: e?.message ?? 'Catalog refresh failed',
          details: { connectionId },
        });
        throw err;
      }
      await audit.record({
        ...entry,
        status: 'success',
        details: { connectionId, degraded: catalog.degraded ?? [] },
      });
      noStore(reply);
      return redact({ connectionId, catalog: await visible(catalog) });
    },
  );

  /**
   * One table with every column, read on its own from the dictionary: the whole catalog may have
   * been cut at the gateway row cap. A table the user may not see, one the connection does not
   * have and a name that is no identifier all get the same answer.
   */
  app.get('/api/schema/tables/:name', async (request, reply) => {
    const { name } = parseBody(tableParams, request.params);
    const { connectionId, visible } = await schemaAccess(request);
    const one = async (table: CatalogTable | undefined) =>
      (
        await visible({
          tables: table ? [table] : [],
          fetchedAt: new Date().toISOString(),
          source: 'dictionary',
        })
      ).tables[0];
    const notFound = () => new AppError('RESOURCE_NOT_FOUND', 'Table not found');
    // A table the user may not see is refused before the dictionary is read, so neither the
    // cost of that read nor its failure tells it apart from a table that does not exist.
    if (!(await one({ name: name.toUpperCase(), columns: [], foreignKeys: [] }))) throw notFound();
    const table = await one(await metadata.table(connectionId, name));
    if (!table) throw notFound();
    noStore(reply);
    return redact({ connectionId, table });
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
