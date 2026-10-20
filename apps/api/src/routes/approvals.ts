import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ApprovalRow } from '@dbx/database';
import { ApprovalsService } from '../services/approvals';
import type { ApprovalAuditContext, PendingApproval } from '../services/approvals';
import { PlansService } from '../services/plans';
import { clientIp, noStore, parseBody, requireAuth, requirePermission, uuidParam } from '../http';

const requestBody = z.object({ planId: z.uuid() }).strict();
const decisionBody = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    reason: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

const toApproval = (a: ApprovalRow) => ({
  id: a.id,
  planId: a.planId,
  planHash: a.planHash,
  requestedBy: a.requestedBy,
  decidedBy: a.decidedBy,
  decision: a.decision,
  reason: a.reason,
  createdAt: a.createdAt.toISOString(),
  decidedAt: a.decidedAt?.toISOString() ?? null,
  expiresAt: a.expiresAt.toISOString(),
});

const toPending = (a: PendingApproval) => ({
  ...toApproval(a),
  requestedByName: a.requestedByName,
  plan: a.plan,
});

/** Four-eyes approvals of plans that require one (Task 14.1). */
export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  const { config, database, policies, authz, redact } = app.services;
  const approvals = new ApprovalsService(database.db, {
    plans: new PlansService(database.db, {
      secret: config.session.secret,
      ttlSeconds: config.planTtlSeconds,
      approvalTtlSeconds: config.approvalTtlMinutes * 60,
    }),
    policies,
    authz,
    redact,
    logger: app.log,
  });

  const context = (request: FastifyRequest, email: string): ApprovalAuditContext => ({
    userEmail: email,
    ip: clientIp(request),
    requestId: request.id,
  });

  app.post('/api/approvals', async (request, reply) => {
    const auth = requireAuth(request);
    const { planId } = parseBody(requestBody, request.body);
    const approval = await approvals.request(
      planId,
      auth.user.id,
      context(request, auth.user.email),
    );
    noStore(reply);
    return reply.code(201).send({ approval: toApproval(approval) });
  });

  app.get('/api/approvals/pending', async (request, reply) => {
    const auth = requirePermission(request, 'APPROVAL.DECIDE');
    noStore(reply);
    return { items: (await approvals.listPending(auth.user.id)).map(toPending) };
  });

  app.post('/api/approvals/:id/decision', async (request, reply) => {
    const auth = requirePermission(request, 'APPROVAL.DECIDE');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(decisionBody, request.body);
    const approval = await approvals.decide(
      id,
      auth.user.id,
      body.decision,
      body.reason || null,
      context(request, auth.user.email),
    );
    noStore(reply);
    return { approval: toApproval(approval) };
  });
}
