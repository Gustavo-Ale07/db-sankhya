import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ENVIRONMENTS } from '@dbx/shared';
import type { AuditEventRow } from '@dbx/database';
import {
  clientIp,
  connectionIdSchema,
  noStore,
  parseBody,
  requirePermission,
  uuidParam,
} from '../http';
import { createMutationService } from '../services/mutation-factory';
import type { PreparedMutation } from '../services/mutations';
import { AUDIT_STATUSES } from '../services/records';
import { ROLLBACK_LABEL, analyzeRollback } from '../services/rollback';
import type { RollbackTarget } from '../services/rollback';
import { valuesMatch } from '../services/verification';

/** Largest page a search may request. */
const MAX_PAGE_SIZE = 200;

const date = z.iso.datetime({ offset: true }).or(z.iso.date());

const auditQuery = z
  .object({
    action: z.string().max(60).optional(),
    userId: z.uuid().optional(),
    userEmail: z.string().max(254).optional(),
    resource: z.string().max(60).optional(),
    /** Outcome of the event. `status` is kept for existing clients; `outcome` is its alias. */
    status: z.enum(AUDIT_STATUSES).optional(),
    outcome: z.enum(AUDIT_STATUSES).optional(),
    environment: z.enum(ENVIRONMENTS).optional(),
    connectionId: connectionIdSchema.optional(),
    planId: z.uuid().optional(),
    from: date.optional(),
    to: date.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict()
  .refine((q) => !q.status || !q.outcome || q.status === q.outcome, {
    message: 'status and outcome disagree',
    path: ['outcome'],
  });

const toAudit = (a: AuditEventRow) => ({
  id: a.id,
  createdAt: a.createdAt.toISOString(),
  userId: a.userId,
  userEmail: a.userEmail,
  ip: a.ip,
  requestId: a.requestId,
  action: a.action,
  operation: a.operation,
  resource: a.resource,
  statement: a.statement,
  targetIds: a.targetIds,
  before: a.before,
  after: a.after,
  gatewayCalls: a.gatewayCalls,
  status: a.status,
  durationMs: a.durationMs,
  errorCode: a.errorCode,
  errorMessage: a.errorMessage,
  details: a.details,
  connectionId: a.connectionId,
  environment: a.environment,
  planId: a.planId,
  planHash: a.planHash,
  capability: a.capability,
  verification: a.verification,
  approvalId: a.approvalId,
  policyDecision: a.policyDecision,
  snapshot: a.snapshot,
});

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const { audit, redact } = app.services;

  app.get('/api/audit', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'AUDIT.READ');
    const { from, to, outcome, status, ...q } = parseBody(auditQuery, request.query);
    const effectiveStatus = status ?? outcome;
    const { items, total } = await audit.list({
      ...q,
      ...(effectiveStatus ? { status: effectiveStatus } : {}),
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: endOfDay(to) } : {}),
    });
    return { items: items.map(toAudit), total };
  });

  // ------------------------------------------------------------ POST /api/audit/:id/rollback-plan
  // Assisted rollback of a VERIFIED UPDATE (Task 13.2). The first rollback statement is prepared
  // through MutationService.prepare under the caller's own permissions and policy: a new plan,
  // a new preview, and the usual confirmation at /api/query/execute. Nothing is written here.
  const mutations = createMutationService(app);
  app.post('/api/audit/:id/rollback-plan', async (request, reply) => {
    noStore(reply);
    const auth = requirePermission(request, 'AUDIT.READ');
    const { id } = parseBody(uuidParam, request.params);
    const event = await audit.get(id);
    if (!event) throw new AppError('NOT_FOUND', 'Audit event not found');
    const analysis = analyzeRollback(event);
    if (!analysis.ok) {
      throw new AppError('CONFLICT', `No rollback plan for this event: ${analysis.reason}`, {
        reason: analysis.reason,
      });
    }
    const first = analysis.targets[0]!;
    const prepared = await mutations.prepare({
      auth,
      sql: first.sql,
      connectionId: analysis.connectionId,
      meta: { ip: clientIp(request), requestId: request.id },
    });
    const conflict = conflictOf(first, prepared);
    // The link from the source event to the new plan must exist before the plan is handed out:
    // if it cannot be written, the caller gets a stable error and no token (the plan stays
    // unusable and lapses with its TTL), never a plan the audit cannot trace back.
    try {
      await audit.record({
        action: 'rollback.planned',
        status: 'info',
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
        operation: 'UPDATE',
        resource: analysis.entity,
        statement: first.sql,
        connectionId: analysis.connectionId,
        environment: prepared.impact.environment,
        planId: prepared.planId,
        details: {
          sourceEventId: event.id,
          sourcePlanId: event.planId,
          statements: analysis.targets.length,
          conflict: conflict.detected,
        },
      });
    } catch (err) {
      request.log.error(
        { planId: prepared.planId, errorName: err instanceof Error ? err.name : typeof err },
        'The rollback plan could not be audited',
      );
      throw new AppError(
        'INTERNAL_ERROR',
        'The rollback plan could not be recorded in the audit, so it was not issued. Try again.',
        { reason: 'ROLLBACK_AUDIT_FAILED' },
      );
    }
    // The plan token is the caller's own confirmation credential: returned outside the redactor.
    const { token, ...shown } = prepared;
    const body = redact({
      type: 'rollback-plan',
      label: ROLLBACK_LABEL,
      sourceEventId: event.id,
      sql: first.sql,
      displaySql: analysis.targets.map((t) => t.sql).join(';\n'),
      statements: analysis.targets.length,
      conflict,
      plan: shown,
    }) as Record<string, unknown> & { plan: Record<string, unknown> };
    return { ...body, plan: { ...body.plan, token } };
  });
}

/**
 * The values the row holds now (the new preview's before) against the snapshot's after: any
 * difference means someone changed the row after the original write.
 */
function conflictOf(target: RollbackTarget, prepared: PreparedMutation) {
  const row = prepared.preview.targets.find((t) =>
    Object.entries(target.key).every(([k, v]) => valuesMatch(v, t.key[k])),
  );
  const before = row?.before;
  if (!before) {
    return {
      detected: true,
      columns: [],
      message: 'The row no longer exists: it was removed or re-keyed after the original write.',
    };
  }
  const columns = Object.entries(target.expectedCurrent)
    .filter(([column, expected]) => !valuesMatch(expected, before[column]))
    .map(([column, expected]) => ({ column, expected, current: before[column] ?? null }));
  return columns.length
    ? {
        detected: true,
        columns,
        message:
          'The row changed after the original write: restoring the old values would overwrite ' +
          'those later changes. Review the preview before confirming.',
      }
    : { detected: false, columns, message: null };
}

function endOfDay(value: string | Date): Date {
  if (typeof value === 'string' && value.length === 10) return new Date(`${value}T23:59:59.999Z`);
  return new Date(value);
}
