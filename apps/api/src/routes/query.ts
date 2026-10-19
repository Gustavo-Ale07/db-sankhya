import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import { MAX_SQL_LENGTH, classifyStatement } from '@dbx/sql-engine';
import type { Classified, ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import { ENV_CONNECTION_ID } from '../services/connections';
import { executeRead } from '../services/read-executor';
import type { PolicyDecision } from '../services/read-executor';
import {
  clientIp,
  connectionIdSchema,
  hasPermission,
  noStore,
  parseBody,
  requireAuth,
  requirePermission,
} from '../http';

/** Until the Sankhya write path (plans, Stage 11) exists, every mutation fails closed. */
const MUTATIONS_UNAVAILABLE = 'Mutations are not available yet.';

const EXECUTION_ID = /^[A-Za-z0-9_-]{8,64}$/;

const queryBody = z
  .object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    executionId: z.string().regex(EXECUTION_ID).optional(),
    /** Sankhya connection to read from; the SANKHYA_* connection when omitted and configured. */
    connectionId: connectionIdSchema.optional(),
  })
  .strict();

const confirmBody = z
  .object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    token: z.string().min(1).max(200),
  })
  .strict();

const cancelBody = z.object({ executionId: z.string().regex(EXECUTION_ID) }).strict();

/** Statement kinds that would change data or schema. */
function mutationKind(c: Classified): string | null {
  return c.kind === 'SELECT' || c.kind === 'UNKNOWN' ? null : c.kind;
}

function mutationTable(c: Classified): string | null {
  return c.kind === 'SELECT' || c.kind === 'UNKNOWN' ? null : c.table;
}

export async function queryRoutes(app: FastifyInstance): Promise<void> {
  const { history, audit, executions, connections, metadata, config, redact } = app.services;

  const safeHistory = async (
    request: FastifyRequest,
    entry: Parameters<typeof history.record>[0],
  ) => {
    try {
      await history.record(entry);
    } catch (err) {
      request.log.error({ err }, 'failed to record query history');
    }
  };

  const auditBase = (request: FastifyRequest, auth: AuthState) => ({
    userId: auth.user.id,
    userEmail: auth.user.email,
    ip: clientIp(request),
    requestId: request.id,
  });

  /**
   * Mutations fail closed: the attempt is audited as denied (who tried what) and nothing is
   * parsed further, planned or sent to any gateway.
   */
  const denyMutation = async (
    request: FastifyRequest,
    auth: AuthState,
    sql: string,
    classified: Classified,
    connectionId: string | null,
  ): Promise<AppError> => {
    const err = new AppError('SQL_UNSUPPORTED', MUTATIONS_UNAVAILABLE);
    await audit.record({
      ...auditBase(request, auth),
      action: 'write.denied',
      status: 'denied',
      operation: mutationKind(classified),
      resource: mutationTable(classified),
      statement: sql,
      errorCode: err.code,
      errorMessage: err.message,
      details: { connectionId },
    });
    return err;
  };

  // ------------------------------------------------------------ POST /api/query
  app.post('/api/query', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(queryBody, request.body);
    const executionId = body.executionId ?? randomUUID();
    // Every mutation fails closed until the Sankhya write path exists; everything else is a
    // Sankhya read, refused there unless it is a plain SELECT.
    const classified = classifyStatement(body.sql);
    const mutation = mutationKind(classified);
    if (mutation === null) {
      return sankhyaRead(request, reply, auth, body.sql, executionId, body.connectionId);
    }
    const err = await denyMutation(request, auth, body.sql, classified, body.connectionId ?? null);
    await safeHistory(request, {
      userId: auth.user.id,
      executionId,
      sql: body.sql,
      status: 'error',
      operation:
        classified.kind === 'INSERT' || classified.kind === 'UPDATE' || classified.kind === 'DELETE'
          ? classified.kind
          : null,
      resource: mutationTable(classified),
      durationMs: 0,
      apiCalls: 0,
      errorCode: err.code,
    });
    throw err;
  });

  /** A read through the Sankhya gateway (`executeQuery`). History keeps the SQL, never rows. */
  async function sankhyaRead(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthState,
    sql: string,
    executionId: string,
    requested: string | undefined,
  ) {
    const started = performance.now();
    // Authorize before resolving the connection, runtime or catalog, so a user without the
    // permission learns nothing about which connections or tables exist.
    try {
      requirePermission(request, 'QUERY.SELECT');
    } catch (err) {
      if (isAppError(err)) {
        await audit.record({
          ...auditBase(request, auth),
          action: 'read.denied',
          status: 'denied',
          operation: 'SELECT',
          resource: null,
          statement: sql,
          errorCode: err.code,
          errorMessage: err.message,
          details: { connectionId: requested ?? null },
        });
        await safeHistory(request, {
          userId: auth.user.id,
          executionId,
          sql,
          status: 'error',
          operation: null,
          resource: null,
          durationMs: Math.round(performance.now() - started),
          apiCalls: 0,
          errorCode: err.code,
        });
      }
      throw err;
    }
    const connectionId = requested ?? defaultConnection();
    let analysis: ReadAnalysis | undefined;
    let allowed = false;
    const decide = (a: ReadAnalysis): PolicyDecision => {
      analysis = a;
      // Until the policy engine (Stage 9): the RBAC permission to read.
      allowed = hasPermission(auth, 'QUERY.SELECT');
      return allowed
        ? { effect: 'ALLOW' }
        : { effect: 'DENY', reason: 'Missing permission: QUERY.SELECT' };
    };
    const resourceOf = () => analysis?.tables[0]?.name ?? null;

    const controller = executions.start(executionId, auth.user.id);
    const onClose = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new AppError('QUERY_CANCELLED', 'The client disconnected'));
    };
    reply.raw.once('close', onClose);
    try {
      const runtime = await connections.getRuntime(connectionId);
      const catalog = await metadata.get(connectionId);
      const out = await executeRead({
        runtime,
        catalog,
        sql,
        maxRows: config.sankhya.maxRows,
        signal: controller.signal,
        decide,
      });
      await safeHistory(request, {
        userId: auth.user.id,
        executionId,
        sql,
        status: 'success',
        operation: 'SELECT',
        resource: resourceOf(),
        durationMs: out.durationMs,
        resultRows: out.rows.length,
        apiCalls: 1,
      });
      return redact({
        type: 'result',
        executionId,
        connectionId,
        kind: 'SELECT',
        resource: resourceOf(),
        columns: out.columns.map((name) => ({ name, type: 'unknown' })),
        rows: out.rows,
        rowCount: out.rows.length,
        truncated: out.truncated,
        apiCalls: 1,
        durationMs: out.durationMs,
        messages:
          out.truncatedBy === 'maxRows'
            ? [`Result truncated to ${config.sankhya.maxRows} rows.`]
            : out.truncatedBy === 'gateway'
              ? [`Result truncated by the gateway at ${out.rows.length} rows.`]
              : [],
      });
    } catch (err) {
      const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
      if (isAppError(err) && (code === 'SQL_FORBIDDEN' || code === 'FORBIDDEN')) {
        await audit.record({
          ...auditBase(request, auth),
          action: 'read.denied',
          status: 'denied',
          operation: 'SELECT',
          resource: resourceOf(),
          statement: sql,
          errorCode: code,
          errorMessage: err.message,
          details: { connectionId },
        });
      }
      await safeHistory(request, {
        userId: auth.user.id,
        executionId,
        sql,
        status: code === 'QUERY_CANCELLED' ? 'cancelled' : 'error',
        operation: analysis ? 'SELECT' : null,
        resource: resourceOf(),
        durationMs: Math.round(performance.now() - started),
        apiCalls: allowed ? 1 : 0,
        errorCode: code,
      });
      throw err;
    } finally {
      reply.raw.off('close', onClose);
      executions.finish(executionId);
    }
  }

  function defaultConnection(): string {
    if (config.sankhya.envConnection) return ENV_CONNECTION_ID;
    throw new AppError(
      'VALIDATION_ERROR',
      'connectionId is required: no default Sankhya connection is configured',
    );
  }

  // ------------------------------------------------------------ POST /api/query/confirm
  // Kept so old clients get a clear answer; there is nothing to confirm while mutations are off.
  app.post('/api/query/confirm', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(confirmBody, request.body);
    throw await denyMutation(request, auth, body.sql, classifyStatement(body.sql), null);
  });

  // ------------------------------------------------------------ POST /api/query/cancel
  app.post('/api/query/cancel', async (request) => {
    const auth = requireAuth(request);
    const body = parseBody(cancelBody, request.body);
    const cancelled = executions.cancel(
      body.executionId,
      auth.user.id,
      hasPermission(auth, 'ADMIN.SECURITY'),
    );
    return { cancelled };
  });
}
