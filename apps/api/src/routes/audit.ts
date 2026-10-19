import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENVIRONMENTS } from '@dbx/shared';
import type { AuditEventRow } from '@dbx/database';
import { connectionIdSchema, noStore, parseBody, requirePermission } from '../http';
import { AUDIT_STATUSES } from '../services/records';

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
  const { audit } = app.services;

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
}

function endOfDay(value: string | Date): Date {
  if (typeof value === 'string' && value.length === 10) return new Date(`${value}T23:59:59.999Z`);
  return new Date(value);
}
