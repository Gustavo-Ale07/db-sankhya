import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import { MAX_SQL_LENGTH, classifyStatement } from '@dbx/sql-engine';
import type { Classified, ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { Catalog } from '../services/metadata';
import { ENV_CONNECTION_ID } from '../services/connections';
import { dropEphemeral, isScratchName, planScratchRead } from '../services/hybrid';
import type { HybridPart, ScratchRead } from '../services/hybrid';
import { materialize } from '../services/materialize';
import { ApprovalsService } from '../services/approvals';
import { MutationService } from '../services/mutations';
import type { SankhyaCopier, SankhyaCopy } from '../services/mutations';
import type { ScratchWorkspace } from '../services/scratch';
import { PlansService } from '../services/plans';
import { executeRead } from '../services/read-executor';
import type { PolicyDecision as ReadDecision } from '../services/read-executor';
import {
  SCRATCH_CONNECTION_ID,
  SCRATCH_ENVIRONMENT,
  authorizeConnection,
  connectionDenied,
  evaluateFor,
  findVisibleTable,
  readCatalog,
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

const DENIED = 'The statement was denied by policy';

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
      // A SELECT that names a tmp_ table runs in the caller's scratch: alone, or (hybrid) with
      // its Sankhya parts copied in first. tmp_ names never reach the Sankhya catalog.
      if (classified.kind === 'SELECT' && classified.tables.some(isScratchName)) {
        const hybrid = !classified.tables.every(isScratchName);
        return scratchRead(request, reply, auth, body.sql, executionId, body.connectionId, hybrid);
      }
      return sankhyaRead(request, reply, auth, body.sql, executionId, body.connectionId);
    }
    // INSERT / UPDATE / DELETE and DDL of tmp_ tables get a pointer to the preview; nothing is
    // planned or sent here, so the first Ctrl+Enter can never write.
    const previewable =
      classified.kind === 'INSERT' ||
      classified.kind === 'UPDATE' ||
      classified.kind === 'DELETE' ||
      ((classified.kind === 'CREATE_TABLE' ||
        classified.kind === 'ALTER_TABLE' ||
        classified.kind === 'DROP_TABLE') &&
        isScratchName(classified.table));
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
    const decideWith = async (a: ReadAnalysis, catalog: Catalog): Promise<ReadDecision> => {
      analysis = a;
      const targets = readTargets(
        a,
        await readCatalog(catalog, a, (name) => metadata.table(connectionId, name)),
      );
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
        decide: decideWith,
        findTable: (name) =>
          findVisibleTable(
            { policies, auth, groupIds, environment: access.environment, connectionId },
            name,
            (n) => metadata.table(connectionId, n),
          ),
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
        source: 'sankhya',
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

  /**
   * A read of the caller's scratch tables, or a hybrid read (`hybrid`): each Sankhya part goes
   * through the Sankhya read path once, under QUERY.SELECT and TEMP.MATERIALIZE exactly as
   * /api/scratch/materialize, capped at min(SANKHYA_MAX_ROWS, MATERIALIZE_MAX_ROWS, policy), into
   * an ephemeral table dropped afterwards (on error and cancel too). Every authorization (both
   * permissions, the scratch read with its columns, the connection, the copy) is decided before
   * the first gateway call.
   */
  async function scratchRead(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthState,
    sql: string,
    executionId: string,
    requested: string | undefined,
    hybrid: boolean,
  ) {
    const started = performance.now();
    const source = hybrid ? 'hybrid' : 'scratch';
    // Echoed so the editor matches the result to the connection it asked for.
    const connectionId = requested ?? (config.sankhya.envConnection ? ENV_CONNECTION_ID : null);
    let plan: ScratchRead | undefined;
    let resource: string | null = null;
    let denied: PolicyDecision | undefined;
    let apiCalls = 0;
    let workspace: Awaited<ReturnType<typeof app.services.scratch.workspace>> | undefined;
    const copied: ScratchRead['parts'] = [];

    const controller = executions.start(executionId, auth.user.id);
    const onClose = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new AppError('QUERY_CANCELLED', 'The client disconnected'));
    };
    reply.raw.once('close', onClose);
    const forbidden = (decision: PolicyDecision) => {
      denied = decision;
      return new AppError('FORBIDDEN', DENIED);
    };
    try {
      requirePermission(request, 'QUERY.SELECT');
      if (hybrid) requirePermission(request, 'TEMP.MATERIALIZE');
      plan = planScratchRead(sql, hybrid);
      const { parts, statement } = plan;
      const ephemeral = new Set(parts.map((p) => p.into));
      resource = statement.tables.find((t) => !ephemeral.has(t)) ?? null;
      const groupIds = await authz.activeGroupIds(auth.user.id);

      // The scratch side: the columns the statement reads from the caller's own tables (the
      // ephemeral copies are judged on the Sankhya side, column by column).
      const read = await evaluateFor({
        policies,
        auth,
        groupIds,
        action: 'QUERY.SELECT',
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: statement.tables.filter((t) => !ephemeral.has(t)),
        columns: (statement.columns ?? []).filter((c) => !ephemeral.has(c.table)),
        defaults: { maxReadRows: config.scratch.maxRows },
      });
      if (read.effect !== 'ALLOW') throw forbidden(read);

      const hybridParts: Array<{ tables: string[]; rows: number; truncated: boolean }> = [];
      workspace = await app.services.scratch.workspace(auth.user.id);
      if (parts.length > 0) {
        hybridParts.push(
          ...(await copySankhyaParts({
            auth,
            groupIds,
            workspace,
            parts,
            requested,
            signal: controller.signal,
            copied,
            onDenied: (d) => {
              denied = d;
            },
            onCall: () => {
              apiCalls += 1;
            },
          })),
        );
      }

      const out = await workspace.execStatement(statement, controller.signal, {
        maxResultRows: read.limits.maxReadRows,
      });
      const durationMs = Math.round(performance.now() - started);
      await safeHistory(request, {
        userId: auth.user.id,
        executionId,
        sql,
        status: 'success',
        operation: 'SELECT',
        resource,
        durationMs,
        resultRows: out.rows.length,
        apiCalls,
      });
      await audit.record({
        ...auditBase(request, auth),
        action: 'read.executed',
        status: 'success',
        operation: 'SELECT',
        resource,
        statement: sql,
        connectionId: SCRATCH_CONNECTION_ID,
        environment: SCRATCH_ENVIRONMENT,
        durationMs,
        details: {
          source,
          connectionId,
          rowCount: out.rows.length,
          truncated: out.truncated,
          ...(hybrid ? { parts: hybridParts } : {}),
        },
      });
      return redact({
        type: 'result',
        executionId,
        connectionId,
        kind: 'SELECT',
        source,
        ...(hybrid ? { hybrid: { parts: hybridParts } } : {}),
        resource,
        columns: out.columns.map((name) => ({ name, type: 'unknown' })),
        rows: out.rows,
        rowCount: out.rows.length,
        truncated: out.truncated,
        apiCalls,
        durationMs,
        messages: [
          ...hybridParts
            .filter((p) => p.truncated)
            .map((p) => `Sankhya part (${p.tables.join(', ')}) cut at ${p.rows} rows.`),
          ...(out.truncated ? [`Result truncated to ${out.rows.length} rows.`] : []),
        ],
      });
    } catch (err) {
      const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
      if (isAppError(err) && (code === 'SQL_FORBIDDEN' || code === 'FORBIDDEN')) {
        await audit.record({
          ...auditBase(request, auth),
          action: 'read.denied',
          status: 'denied',
          operation: 'SELECT',
          resource,
          statement: sql,
          errorCode: code,
          errorMessage: err.message,
          details: {
            source,
            connectionId,
            ...(denied
              ? {
                  reasons: denied.reasons,
                  matchedRuleIds: denied.matchedRuleIds,
                  policyVersion: denied.policyVersion,
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
        operation: plan ? 'SELECT' : null,
        resource,
        durationMs: Math.round(performance.now() - started),
        apiCalls,
        errorCode: code,
      });
      throw err;
    } finally {
      if (workspace && copied.length > 0) {
        await dropEphemeral(workspace, copied, (err) =>
          request.log.error({ err }, 'failed to drop an ephemeral hybrid table'),
        );
      }
      reply.raw.off('close', onClose);
      executions.finish(executionId);
    }
  }

  /**
   * Copies each Sankhya part once into its ephemeral scratch table, through the Sankhya read
   * path: QUERY.SELECT and TEMP.MATERIALIZE on the source (columns included) and TEMP.MATERIALIZE
   * on the scratch side, capped at min(SANKHYA_MAX_ROWS, MATERIALIZE_MAX_ROWS, policy). Every
   * authorization of the source happens before its first gateway call. Reads only.
   */
  async function copySankhyaParts(o: {
    auth: AuthState;
    groupIds: string[];
    workspace: ScratchWorkspace;
    parts: readonly HybridPart[];
    requested: string | undefined;
    signal: AbortSignal;
    /** Every part a copy was started for (the caller drops them). */
    copied?: HybridPart[];
    onDenied: (decision: PolicyDecision) => void;
    onCall: () => void;
  }): Promise<SankhyaCopy[]> {
    const { auth, groupIds, workspace, parts, requested } = o;
    const forbidden = (decision: PolicyDecision) => {
      o.onDenied(decision);
      return new AppError('FORBIDDEN', DENIED);
    };
    const result: SankhyaCopy[] = [];
    const sourceId = requested ?? defaultConnection();
    const defaults = { maxReadRows: config.materializeMaxRows };
    const target = await evaluateFor({
      policies,
      auth,
      groupIds,
      action: 'TEMP.MATERIALIZE',
      environment: SCRATCH_ENVIRONMENT,
      connectionId: SCRATCH_CONNECTION_ID,
      entities: parts.map((p) => p.into),
      defaults,
    });
    if (target.effect !== 'ALLOW') throw forbidden(target);
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds,
      action: 'QUERY.SELECT',
      connectionId: sourceId,
      connections,
      defaults,
    });
    if (!access.ok) throw connectionDenied();
    const sourceAccess = await evaluateFor({
      policies,
      auth,
      groupIds,
      action: 'TEMP.MATERIALIZE',
      environment: access.environment,
      connectionId: sourceId,
      entities: [],
      columns: [],
      defaults,
    });
    if (sourceAccess.effect !== 'ALLOW') throw forbidden(sourceAccess);

    const decideWith = async (a: ReadAnalysis, catalog: Catalog): Promise<ReadDecision> => {
      const targets = readTargets(
        a,
        await readCatalog(catalog, a, (name) => metadata.table(sourceId, name)),
      );
      const check = {
        policies,
        auth,
        groupIds,
        environment: access.environment,
        connectionId: sourceId,
        entities: targets.entities,
        columns: targets.columns,
        defaults,
      };
      const select = await evaluateFor({ ...check, action: 'QUERY.SELECT' });
      if (select.effect !== 'ALLOW') {
        o.onDenied(select);
        return { effect: 'DENY', reason: 'The read was denied by policy' };
      }
      const copy = await evaluateFor({ ...check, action: 'TEMP.MATERIALIZE' });
      if (copy.effect !== 'ALLOW') {
        o.onDenied(copy);
        return { effect: 'DENY', reason: DENIED };
      }
      o.onCall();
      return {
        effect: 'ALLOW',
        maxRows: Math.min(
          target.limits.maxReadRows,
          select.limits.maxReadRows,
          copy.limits.maxReadRows,
        ),
      };
    };
    const runtime = await connections.getRuntime(sourceId);
    const catalog = await metadata.get(sourceId);
    // One part at a time, each read exactly once.
    for (const part of parts) {
      o.copied?.push(part);
      const out = await materialize({
        runtime,
        workspace,
        sql: part.sql,
        into: part.into,
        maxRows: Math.min(config.sankhya.maxRows, config.materializeMaxRows),
        decide: decideWith,
        findTable: (name) =>
          findVisibleTable(
            {
              policies,
              auth,
              groupIds,
              environment: access.environment,
              connectionId: sourceId,
            },
            name,
            (n) => metadata.table(sourceId, n),
          ),
        catalog,
        signal: o.signal,
      });
      result.push({ tables: part.tables, rows: out.rows, truncated: out.truncated });
    }
    return result;
  }

  /** The copier of a CREATE TABLE tmp_… AS from Sankhya (preview and execute). */
  function copierFor(request: FastifyRequest, auth: AuthState): SankhyaCopier {
    return async (workspace, parts, sourceConnectionId) => {
      requirePermission(request, 'QUERY.SELECT');
      requirePermission(request, 'TEMP.MATERIALIZE');
      const groupIds = await authz.activeGroupIds(auth.user.id);
      return copySankhyaParts({
        auth,
        groupIds,
        workspace,
        parts,
        requested: sourceConnectionId,
        // Not tied to the request: a plan runs to its end once confirmed.
        signal: new AbortController().signal,
        onDenied: () => undefined,
        onCall: () => undefined,
      });
    };
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
      copier: copierFor(request, auth),
      // The only caller that lets DATA.PREVIEW stand in for the statement permission.
      allowPreviewOnly: true,
      meta: { ip: clientIp(request), requestId: request.id },
    });
    // Whether execute would pass the write switches right now (it checks them again itself).
    const globalWrite = (await security.globalWriteState()).effective;
    const available =
      globalWrite &&
      (prepared.capability.class === 'SCRATCH_ONLY' ||
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
      copier: copierFor(request, auth),
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
