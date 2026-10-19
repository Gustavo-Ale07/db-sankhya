/**
 * Scratch workspace routes: per-user `tmp_*` tables, and materialization of a Sankhya read into
 * one. Every route authenticates, then parses and validates its input, then authorizes (RBAC
 * permission and policy) before any workspace, connection or catalog is touched.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import type { Permission, PolicyDecision } from '@dbx/shared';
import { MAX_SQL_LENGTH } from '@dbx/sql-engine';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import {
  clientIp,
  connectionIdSchema,
  hasPermission,
  noStore,
  parseBody,
  requireAuth,
  requirePermission,
} from '../http';
import { ENV_CONNECTION_ID } from '../services/connections';
import { materialize } from '../services/materialize';
import type { Catalog } from '../services/metadata';
import type { PolicyDecision as ReadDecision } from '../services/read-executor';
import {
  SCRATCH_CONNECTION_ID,
  SCRATCH_ENVIRONMENT,
  authorizeConnection,
  connectionDenied,
  evaluateFor,
  readTargets,
} from '../services/read-policy';
import {
  MAX_SCRATCH_SQL_LENGTH,
  analyzeScratchSql,
  assertScratchTableName,
} from '../services/scratch-guard';

const execBody = z.object({ sql: z.string().min(1).max(MAX_SCRATCH_SQL_LENGTH) }).strict();

const materializeBody = z
  .object({
    /** A Sankhya read. */
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    /** Target scratch table (`tmp_*`). */
    into: z.string().min(1).max(64),
    /** Sankhya connection to read from; the SANKHYA_* connection when omitted and configured. */
    connectionId: connectionIdSchema.optional(),
    /** An existing table of that name is only overwritten when this is true. */
    replace: z.boolean().optional(),
  })
  .strict();

const DENIED = 'The statement was denied by policy';

export async function scratchRoutes(app: FastifyInstance): Promise<void> {
  const { scratch, audit, connections, metadata, policies, authz, config, redact } = app.services;

  interface Denial {
    operation: string;
    resource: string | null;
    statement: string | null;
    err: AppError;
    details?: Record<string, unknown>;
  }

  const recordDenial = (request: FastifyRequest, auth: AuthState, d: Denial) =>
    audit.record({
      userId: auth.user.id,
      userEmail: auth.user.email,
      ip: clientIp(request),
      requestId: request.id,
      action: 'scratch.denied',
      status: 'denied',
      operation: d.operation,
      resource: d.resource,
      statement: d.statement,
      errorCode: d.err.code,
      errorMessage: d.err.message,
      ...(d.details ? { details: d.details } : {}),
    });

  /** The RBAC permission, audited when missing. */
  const requireFor = async (
    request: FastifyRequest,
    auth: AuthState,
    permission: Permission,
    d: Omit<Denial, 'err'>,
  ) => {
    if (hasPermission(auth, permission)) return;
    const err = new AppError('FORBIDDEN', 'You do not have permission for this action', {
      permission,
    });
    await recordDenial(request, auth, { ...d, err });
    throw err;
  };

  const policyDetails = (decision: PolicyDecision) => ({
    reasons: decision.reasons,
    matchedRuleIds: decision.matchedRuleIds,
    policyVersion: decision.policyVersion,
  });

  /** Aborts the signal when the client goes away before the reply is sent. */
  const abortOnClose = (reply: FastifyReply) => {
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableEnded)
        controller.abort(new AppError('QUERY_CANCELLED', 'The client disconnected'));
    };
    reply.raw.once('close', onClose);
    return { signal: controller.signal, release: () => reply.raw.off('close', onClose) };
  };

  // ------------------------------------------------------------ POST /api/scratch/exec
  app.post(
    '/api/scratch/exec',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      const body = parseBody(execBody, request.body);
      const stmt = analyzeScratchSql(body.sql);
      const tables = [...new Set([...stmt.tables, ...(stmt.target ? [stmt.target] : [])])];
      const denial = {
        operation: stmt.command,
        resource: stmt.target ?? stmt.tables[0] ?? null,
        statement: stmt.sql,
      };
      await requireFor(request, auth, stmt.action, denial);
      const decision = await evaluateFor({
        policies,
        auth,
        groupIds: await authz.activeGroupIds(auth.user.id),
        action: stmt.action,
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: tables,
      });
      if (decision.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, { ...denial, err, details: policyDetails(decision) });
        throw err;
      }
      const workspace = await scratch.workspace(auth.user.id);
      const { signal, release } = abortOnClose(reply);
      try {
        return redact(await workspace.execStatement(stmt, signal));
      } finally {
        release();
      }
    },
  );

  // ------------------------------------------------------------ GET /api/scratch/tables
  app.get(
    '/api/scratch/tables',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requirePermission(request, 'QUERY.SELECT');
      const workspace = await scratch.workspace(auth.user.id);
      return { tables: await workspace.tables() };
    },
  );

  // ------------------------------------------------------------ POST /api/scratch/materialize
  app.post(
    '/api/scratch/materialize',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      const body = parseBody(materializeBody, request.body);
      assertScratchTableName(body.into);
      const denial = { operation: 'MATERIALIZE', resource: body.into, statement: body.sql };
      // Both permissions: reading the source and writing the result into scratch.
      await requireFor(request, auth, 'QUERY.SELECT', denial);
      await requireFor(request, auth, 'TEMP.MATERIALIZE', denial);
      const connectionId = body.connectionId ?? defaultConnection();
      const groupIds = await authz.activeGroupIds(auth.user.id);

      const target = await evaluateFor({
        policies,
        auth,
        groupIds,
        action: 'TEMP.MATERIALIZE',
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: [body.into],
      });
      if (target.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, { ...denial, err, details: policyDetails(target) });
        throw err;
      }
      // MATERIALIZE_MAX_ROWS is the ceiling of the copy; read rules can only lower it.
      const defaults = { maxReadRows: config.materializeMaxRows };
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
        await recordDenial(request, auth, {
          ...denial,
          err,
          details: { connectionId, reasons: access.reasons },
        });
        throw err;
      }

      const workspace = await scratch.workspace(auth.user.id);
      // The workspace belongs to this user alone, so the check cannot race another user.
      const exists = (await workspace.tables()).some((t) => t.name === body.into);
      if (exists && body.replace !== true) {
        throw new AppError(
          'CONFLICT',
          `Scratch table ${body.into} already exists; send replace: true to overwrite it`,
        );
      }

      let source: PolicyDecision | undefined;
      const decideWith =
        (catalog: Catalog) =>
        async (a: ReadAnalysis): Promise<ReadDecision> => {
          const targets = readTargets(a, catalog);
          source = await evaluateFor({
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
          return source.effect === 'ALLOW'
            ? { effect: 'ALLOW', maxRows: source.limits.maxReadRows }
            : { effect: 'DENY', reason: 'The read was denied by policy' };
        };

      const { signal, release } = abortOnClose(reply);
      try {
        const runtime = await connections.getRuntime(connectionId);
        const catalog = await metadata.get(connectionId);
        const out = await materialize({
          runtime,
          workspace,
          sql: body.sql,
          into: body.into,
          maxRows: config.materializeMaxRows,
          decide: decideWith(catalog),
          catalog,
          signal,
        });
        await audit.record({
          userId: auth.user.id,
          userEmail: auth.user.email,
          ip: clientIp(request),
          requestId: request.id,
          action: 'scratch.materialize',
          status: out.truncated ? 'partial' : 'success',
          operation: 'MATERIALIZE',
          resource: out.table,
          statement: body.sql,
          details: { connectionId, rows: out.rows, truncated: out.truncated },
        });
        return out;
      } catch (err) {
        if (isAppError(err) && (err.code === 'FORBIDDEN' || err.code === 'SQL_FORBIDDEN')) {
          await recordDenial(request, auth, {
            ...denial,
            err,
            details: {
              connectionId,
              ...(source && source.effect !== 'ALLOW' ? policyDetails(source) : {}),
            },
          });
        }
        throw err;
      } finally {
        release();
      }
    },
  );

  function defaultConnection(): string {
    if (config.sankhya.envConnection) return ENV_CONNECTION_ID;
    throw new AppError(
      'VALIDATION_ERROR',
      'connectionId is required: no default Sankhya connection is configured',
    );
  }
}
