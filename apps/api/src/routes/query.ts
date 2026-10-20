import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import { MAX_SQL_LENGTH, classifyStatement } from '@dbx/sql-engine';
import type { Classified, ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { Catalog } from '../services/metadata';
import { ENV_CONNECTION_ID } from '../services/connections';
import { ApprovalsService } from '../services/approvals';
import { MutationService } from '../services/mutations';
import { PlansService } from '../services/plans';
import { executeRead } from '../services/read-executor';
import type { PolicyDecision as ReadDecision } from '../services/read-executor';
import {
  authorizeConnection,
  connectionDenied,
  evaluateFor,
  readTargets,
} from '../services/read-policy';
import type { PolicyDecision } from '@dbx/shared';
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
/** /api/query never runs a mutation: INSERT / UPDATE / DELETE are only previewed (Task 11.2a). */
const USE_PREVIEW = 'Mutations are never executed here. Preview them with /api/query/preview.';
const PREVIEW_URL = '/api/query/preview';

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

const previewBody = z
  .object({
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    /** Sankhya connection; the SANKHYA_* connection when omitted and configured. */
    connectionId: connectionIdSchema.optional(),
  })
  .strict();

const executeBody = z
  .object({
    planId: z.uuid(),
    token: z.string().min(1).max(200),
    strongConfirmation: z.string().max(300).optional(),
    idempotencyKey: z.string().min(1).max(200),
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
  const { history, audit, executions, connections, metadata, config, redact, policies, authz } =
    app.services;
  const { security } = app.services;
  const plans = new PlansService(app.services.database.db, {
    secret: config.session.secret,
    ttlSeconds: config.planTtlSeconds,
    approvalTtlSeconds: config.approvalTtlMinutes * 60,
  });
  const ceilings = {
    sankhyaMaxReadRows: config.sankhya.maxRows,
    scratchMaxReadRows: config.scratch.maxRows,
  };
  const mutations = new MutationService({
    policies,
    authz,
    connections,
    metadata,
    audit,
    scratch: app.services.scratch,
    plans,
    // Plans that require approval are consumed only through the approvals service.
    approvals: new ApprovalsService(app.services.database.db, {
      plans,
      policies,
      authz,
      redact,
      logger: app.log,
      ceilings,
    }),
    security,
    switches: { safeMode: config.safeMode, writeToSankhya: config.writeToSankhya },
    maxReadRows: ceilings.sankhyaMaxReadRows,
    scratchMaxReadRows: ceilings.scratchMaxReadRows,
    logger: app.log,
  });

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
    previewable = false,
  ): Promise<AppError> => {
    const err = previewable
      ? new AppError('SQL_UNSUPPORTED', USE_PREVIEW, { preview: PREVIEW_URL })
      : new AppError('SQL_UNSUPPORTED', MUTATIONS_UNAVAILABLE);
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
    // INSERT / UPDATE / DELETE get a pointer to the preview; nothing is planned or sent here, so
    // the first Ctrl+Enter can never write.
    const previewable =
      classified.kind === 'INSERT' || classified.kind === 'UPDATE' || classified.kind === 'DELETE';
    const err = await denyMutation(
      request,
      auth,
      body.sql,
      classified,
      body.connectionId ?? null,
      previewable,
    );
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
    // SANKHYA_MAX_ROWS is the ceiling; policy rules can only lower it.
    const defaults = { maxReadRows: config.sankhya.maxRows };
    const groupIds = await authz.activeGroupIds(auth.user.id);
    // The connection (and its environment) is authorized before its runtime or catalog is
    // touched. An unknown connection gets the same answer as a denied one.
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds,
      action: 'QUERY.SELECT',
      connectionId,
      connections,
      defaults,
    });
    if (!access.ok) {
      const err = connectionDenied();
      await audit.record({
        ...auditBase(request, auth),
        action: 'read.denied',
        status: 'denied',
        operation: 'SELECT',
        resource: null,
        statement: sql,
        errorCode: err.code,
        errorMessage: err.message,
        details: { connectionId, reasons: access.reasons },
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
      throw err;
    }
    let analysis: ReadAnalysis | undefined;
    let policy: PolicyDecision | undefined;
    let allowed = false;
    const decideWith =
      (catalog: Catalog) =>
      async (a: ReadAnalysis): Promise<ReadDecision> => {
        analysis = a;
        const targets = readTargets(a, catalog);
        policy = await evaluateFor({
          policies,
          auth,
          groupIds,
          action: 'QUERY.SELECT',
          environment: access.environment,
          connectionId,
          entities: targets.entities,
          columns: targets.columns,
          defaults,
        });
        allowed = policy.effect === 'ALLOW';
        // The rule internals stay in the audit log; the user gets a generic denial.
        return allowed
          ? { effect: 'ALLOW', maxRows: policy.limits.maxReadRows }
          : { effect: 'DENY', reason: 'The read was denied by policy' };
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
        decide: decideWith(catalog),
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
      // Who read what, where: the statement (redacted by the audit service) and the row count,
      // never the rows.
      await audit.record({
        ...auditBase(request, auth),
        action: 'read.executed',
        status: 'success',
        operation: 'SELECT',
        resource: resourceOf(),
        statement: sql,
        connectionId,
        environment: access.environment,
        durationMs: out.durationMs,
        details: { connectionId, rowCount: out.rows.length, truncated: out.truncated },
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
            ? [`Result truncated to ${out.maxRows} rows.`]
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
          details: {
            connectionId,
            ...(policy && policy.effect !== 'ALLOW'
              ? {
                  reasons: policy.reasons,
                  matchedRuleIds: policy.matchedRuleIds,
                  policyVersion: policy.policyVersion,
                }
              : {}),
          },
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

  // ------------------------------------------------------------ POST /api/query/preview
  // Plans an INSERT / UPDATE / DELETE and returns its preview. Never writes: the plan runs only
  // through /api/query/execute. `execution.available` reports whether the write switches
  // (SAFE_MODE, GLOBAL_WRITE_ENABLED, WRITE_TO_SANKHYA) would let it run now. MutationService
  // audits every preview, allowed or denied.
  app.post('/api/query/preview', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(previewBody, request.body);
    const prepared = await mutations.prepare({
      auth,
      sql: body.sql,
      connectionId: body.connectionId ?? defaultConnection(),
      // The only caller that lets DATA.PREVIEW stand in for the statement permission.
      allowPreviewOnly: true,
      meta: { ip: clientIp(request), requestId: request.id },
    });
    // Whether execute would pass the write switches right now (it checks them again itself).
    const globalWrite = (await security.globalWriteState()).effective;
    const available =
      globalWrite &&
      (prepared.capability.route === 'SCRATCH' ||
        (config.writeToSankhya &&
          !(config.safeMode && prepared.impact.environment === 'PRODUCTION')));
    // The plan token is the caller's own confirmation credential (bound to this session by an
    // HMAC): it is returned as is, outside the redactor, which would mask any `token` key.
    const { token, permitted, ...shown } = prepared;
    return {
      ...(redact({
        type: 'preview',
        ...shown,
        execution: {
          available,
          // Whether the caller holds the permission execute checks (false for DATA.PREVIEW only).
          permitted,
          safeMode: config.safeMode,
          globalWriteEnabled: globalWrite,
          writeToSankhya: config.writeToSankhya,
        },
      }) as Record<string, unknown>),
      token,
    };
  });

  // ------------------------------------------------------------ POST /api/query/execute
  // Executes a previewed plan: re-authorizes, writes, verifies and audits (MutationService).
  // Nothing runs without the plan token of this session; the idempotency key makes retries safe.
  app.post('/api/query/execute', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const body = parseBody(executeBody, request.body);
    const report = await mutations.execute({
      auth,
      planId: body.planId,
      token: body.token,
      idempotencyKey: body.idempotencyKey,
      ...(body.strongConfirmation !== undefined
        ? { strongConfirmation: body.strongConfirmation }
        : {}),
      meta: { ip: clientIp(request), requestId: request.id },
    });
    return redact({ type: 'execution', planId: body.planId, ...report });
  });

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
