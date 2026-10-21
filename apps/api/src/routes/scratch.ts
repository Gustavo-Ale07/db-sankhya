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
  readCatalog,
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
      // A SELECT carries the columns it reads; any other statement is evaluated as `*` on every
      // table it touches. SCRATCH_MAX_ROWS is the read ceiling that rules can only lower. Writes
      // are capped only when a matching rule sets maxWriteRows (the default write cap is meant
      // for ERP writes); otherwise the workspace row and byte quotas bound them.
      const decision = await evaluateFor({
        policies,
        auth,
        groupIds: await authz.activeGroupIds(auth.user.id),
        action: stmt.action,
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: tables,
        hasWhere: stmt.hasWhere,
        ...(stmt.columns ? { columns: stmt.columns } : {}),
        defaults: { maxReadRows: config.scratch.maxRows },
      });
      if (decision.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, { ...denial, err, details: policyDetails(decision) });
        throw err;
      }
      const workspace = await scratch.workspace(auth.user.id);
      const { signal, release } = abortOnClose(reply);
      try {
        return redact(
          await workspace.execStatement(stmt, signal, {
            maxResultRows: decision.limits.maxReadRows,
            ...(stmt.mutating && decision.rowLimitsFromRules.maxWriteRows
              ? { maxWriteRows: decision.limits.maxWriteRows }
              : {}),
          }),
        );
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
      // Listing reads table names and row counts only: no entity or column rule applies, but a
      // rule that denies reads in the scratch context (SANDBOX, or every environment) does.
      const decision = await evaluateFor({
        policies,
        auth,
        groupIds: await authz.activeGroupIds(auth.user.id),
        action: 'QUERY.SELECT',
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: [],
        columns: [],
      });
      if (decision.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, {
          operation: 'TABLES',
          resource: null,
          statement: null,
          err,
          details: policyDetails(decision),
        });
        throw err;
      }
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

      // MATERIALIZE_MAX_ROWS is the ceiling of the copy; the maxReadRows of every
      // rule below (both TEMP.MATERIALIZE contexts and the source read) can only lower it.
      const defaults = { maxReadRows: config.materializeMaxRows };

      // TEMP.MATERIALIZE is evaluated in both contexts and must be allowed in each: the scratch
      // side (SANDBOX, `scratch`, the target table) and the source side (the Sankhya connection,
      // its environment, then the entities and columns the read touches). QUERY.SELECT is
      // evaluated on the source side only.
      const target = await evaluateFor({
        policies,
        auth,
        groupIds,
        action: 'TEMP.MATERIALIZE',
        environment: SCRATCH_ENVIRONMENT,
        connectionId: SCRATCH_CONNECTION_ID,
        entities: [body.into],
        defaults,
      });
      if (target.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, { ...denial, err, details: policyDetails(target) });
        throw err;
      }
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
      // Source connection and environment, before the runtime or catalog is touched.
      const sourceAccess = await evaluateFor({
        policies,
        auth,
        groupIds,
        action: 'TEMP.MATERIALIZE',
        environment: access.environment,
        connectionId,
        entities: [],
        columns: [],
        defaults,
      });
      if (sourceAccess.effect !== 'ALLOW') {
        const err = new AppError('FORBIDDEN', DENIED);
        await recordDenial(request, auth, {
          ...denial,
          err,
          details: { connectionId, ...policyDetails(sourceAccess) },
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
          const targets = readTargets(
            a,
            await readCatalog(catalog, a, (name) => metadata.table(connectionId, name)),
          );
          const check = {
            policies,
            auth,
            groupIds,
            environment: access.environment,
            connectionId,
            entities: targets.entities,
            columns: targets.columns,
            defaults,
          };
          const read = await evaluateFor({ ...check, action: 'QUERY.SELECT' });
          source = read;
          if (read.effect !== 'ALLOW')
            return { effect: 'DENY', reason: 'The read was denied by policy' };
          const copy = await evaluateFor({ ...check, action: 'TEMP.MATERIALIZE' });
          source = copy;
          if (copy.effect !== 'ALLOW') return { effect: 'DENY', reason: DENIED };
          return {
            effect: 'ALLOW',
            maxRows: Math.min(
              target.limits.maxReadRows,
              read.limits.maxReadRows,
              copy.limits.maxReadRows,
            ),
          };
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
