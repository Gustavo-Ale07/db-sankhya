import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { approvals, groupMembers, groups, plans, users } from '@dbx/database';
import type { ApprovalRow, Database, PlanRow } from '@dbx/database';
import { AppError, isPermission } from '@dbx/shared';
import type { Environment, Permission } from '@dbx/shared';
import { classifyStatement } from '@dbx/sql-engine';
import type { AuthzService } from './authz';
import type { ConsumePlanInput, ConsumedPlan, PlansService } from './plans';
import type { PolicyService } from './policy';
import { AuditService } from './records';

export type { ApprovalRow };
export type ApprovalDecision = 'APPROVE' | 'REJECT';

/** Request metadata copied to the audit rows. */
export interface ApprovalAuditContext {
  userEmail?: string;
  ip?: string;
  requestId?: string;
}

/** A pending approval with what the decider needs to judge the plan. */
export interface PendingApproval extends ApprovalRow {
  plan: {
    environment: string;
    connectionId: string;
    sql: string;
    previewKind: string;
    preview: unknown;
  };
}

export interface ApprovalsDeps {
  plans: PlansService;
  policies: PolicyService;
  authz: AuthzService;
  /** Redactor of the audit rows (the same one AuditService uses). */
  redact: (value: unknown) => unknown;
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 1000;
const PENDING_LIMIT = 200;

const notFound = () => new AppError('NOT_FOUND', 'Approval not found');
const planNotFound = () => new AppError('NOT_FOUND', 'Plan not found');
const invalid = () =>
  new AppError('CONFIRMATION_INVALID', 'Invalid confirmation. Generate a new preview.');
const expired = () =>
  new AppError('CONFIRMATION_EXPIRED', 'The confirmation expired. Generate a new preview.');
const forbidden = (message: string, reason: string) =>
  new AppError('FORBIDDEN', message, { reason });

/**
 * Four-eyes approvals bound to the plan hash (Task 14.1).
 *
 * - `request`: the plan owner asks for approval of a live plan that requires one. The approval
 *   copies `plan_hash` and the plan's `expires_at`, so it expires together with the plan.
 * - `decide`: the decider needs APPROVAL.DECIDE, a policy ALLOW for the plan's actions and
 *   entities, and must not be the requester. The approval row and the plan move in one
 *   transaction through conditional UPDATEs (decision still empty, hash equal, not expired), so of
 *   two racing deciders exactly one wins; the other gets CONFLICT. APPROVE moves the plan to
 *   APPROVED; REJECT moves it to INVALIDATED, so it can never be consumed.
 * - `consumeApproved` is the execution boundary for plans that require approval. Until the
 *   execution orchestrator (Task 11.2) exists, "execute" means a successful `PlansService.consume`.
 *   It maps a rejected or still pending approval to FORBIDDEN, and an approval of another plan or
 *   whose hash no longer equals the plan's to CONFIRMATION_INVALID. Everything else (invalidated,
 *   expired, used plan) is reported by `PlansService.consume` as usual.
 */
export class ApprovalsService {
  constructor(
    private readonly db: Database,
    private readonly deps: ApprovalsDeps,
  ) {}

  async request(
    planId: string,
    userId: string,
    context: ApprovalAuditContext = {},
  ): Promise<ApprovalRow> {
    if (typeof planId !== 'string' || !UUID.test(planId)) throw planNotFound();
    const [current] = await this.db
      .select({ plan: plans, expired: sql<boolean>`${plans.expiresAt} <= now()` })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    // Only the plan owner may ask; anyone else learns nothing about the plan.
    if (!current || current.plan.userId !== userId) throw planNotFound();
    const { plan } = current;
    if (!plan.requiresApproval)
      throw new AppError('VALIDATION_ERROR', 'This plan does not require approval.');
    if (plan.status === 'EXPIRED' || (plan.status === 'PENDING' && current.expired))
      throw expired();
    if (plan.status !== 'PENDING') throw invalid();

    const [existing] = await this.db
      .select()
      .from(approvals)
      .where(eq(approvals.planId, plan.id))
      .limit(1);
    if (existing) return existing;
    const [row] = await this.db
      .insert(approvals)
      .values({
        planId: plan.id,
        planHash: plan.planHash,
        requestedBy: userId,
        expiresAt: plan.expiresAt,
      })
      .onConflictDoNothing({ target: approvals.planId })
      .returning();
    if (!row) {
      // A concurrent request for the same plan won the insert.
      const [winner] = await this.db
        .select()
        .from(approvals)
        .where(eq(approvals.planId, plan.id))
        .limit(1);
      if (!winner) throw invalid();
      return winner;
    }
    await this.audit(this.db).record({
      ...this.auditBase(userId, context),
      action: 'approval.request',
      status: 'success',
      resource: 'plan',
      details: { approvalId: row.id, planId: plan.id, planHash: plan.planHash },
    });
    return row;
  }

  /**
   * Records the decision, or throws: NOT_FOUND, VALIDATION_ERROR, FORBIDDEN (self-approval, no
   * APPROVAL.DECIDE, no policy ALLOW), CONFLICT (already decided), CONFIRMATION_EXPIRED or
   * CONFIRMATION_INVALID (plan no longer live, or its hash differs). Each decision writes an
   * audit row in the same transaction; a refused attempt by an authorised-looking decider is
   * audited as `denied`.
   */
  async decide(
    approvalId: string,
    deciderId: string,
    decision: ApprovalDecision,
    reason: string | null,
    context: ApprovalAuditContext = {},
  ): Promise<ApprovalRow> {
    if (decision !== 'APPROVE' && decision !== 'REJECT')
      throw new AppError('VALIDATION_ERROR', 'decision must be APPROVE or REJECT');
    if (
      reason !== null &&
      (typeof reason !== 'string' || reason.length > MAX_REASON || reason.includes('\u0000'))
    )
      throw new AppError('VALIDATION_ERROR', `reason must be at most ${MAX_REASON} characters`);
    if (typeof approvalId !== 'string' || !UUID.test(approvalId)) throw notFound();
    if (typeof deciderId !== 'string' || !UUID.test(deciderId)) throw notFound();

    const [current] = await this.db
      .select({ approval: approvals, plan: plans })
      .from(approvals)
      .innerJoin(plans, eq(plans.id, approvals.planId))
      .where(eq(approvals.id, approvalId))
      .limit(1);
    if (!current) throw notFound();
    const { approval, plan } = current;
    const details = { approvalId, planId: plan.id, planHash: approval.planHash, decision };

    try {
      await this.assertMayDecide(deciderId, approval, plan);
    } catch (err) {
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        await this.audit(this.db).record({
          ...this.auditBase(deciderId, context),
          action: 'approval.decide',
          status: 'denied',
          resource: 'plan',
          errorCode: err.code,
          errorMessage: err.message,
          details: { ...details, reason: err.details?.reason },
        });
      }
      throw err;
    }

    return this.db.transaction(async (tx) => {
      const [decided] = await tx
        .update(approvals)
        .set({ decision, decidedBy: deciderId, reason, decidedAt: sql`now()` })
        .where(
          and(
            eq(approvals.id, approval.id),
            isNull(approvals.decision),
            ne(approvals.requestedBy, deciderId),
            eq(approvals.planHash, plan.planHash),
            gt(approvals.expiresAt, sql`now()`),
          ),
        )
        .returning();
      if (!decided) throw await this.refusal(tx, approval.id, plan);
      // The plan moves in the same transaction; if it is no longer a live PENDING plan with the
      // approved hash, the whole decision is rolled back.
      if (!(await this.deps.plans.decide(plan.id, decided.planHash, decision, tx)))
        throw await this.planRefusal(tx, plan.id);
      await this.audit(tx).record({
        ...this.auditBase(deciderId, context),
        action: 'approval.decide',
        status: 'success',
        resource: 'plan',
        details: { ...details, requestedBy: approval.requestedBy, reason },
      });
      return decided;
    });
  }

  /** Undecided, unexpired approvals the user may decide (never their own requests). */
  async listPending(forUserId: string): Promise<PendingApproval[]> {
    if (typeof forUserId !== 'string' || !UUID.test(forUserId)) return [];
    const rows = await this.db
      .select({ approval: approvals, plan: plans })
      .from(approvals)
      .innerJoin(plans, eq(plans.id, approvals.planId))
      .where(
        and(
          isNull(approvals.decision),
          gt(approvals.expiresAt, sql`now()`),
          ne(approvals.requestedBy, forUserId),
          eq(plans.status, 'PENDING'),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(PENDING_LIMIT);
    const out: PendingApproval[] = [];
    for (const { approval, plan } of rows) {
      if (approval.planHash !== plan.planHash) continue;
      try {
        await this.assertMayDecide(forUserId, approval, plan);
      } catch {
        continue;
      }
      out.push({
        ...approval,
        plan: {
          environment: plan.environment,
          connectionId: plan.connectionId,
          sql: plan.sql,
          previewKind: plan.previewKind,
          preview: plan.preview,
        },
      });
    }
    return out;
  }

  /**
   * Execution boundary of a plan that requires approval (see the class comment). The approval
   * must belong to this plan, be APPROVE, and carry the plan's current hash; the plan is then
   * consumed by `PlansService.consume`, whose result is checked against the hash once more.
   */
  async consumeApproved(input: ConsumePlanInput & { approvalId: string }): Promise<ConsumedPlan> {
    const { approvalId, ...consume } = input;
    if (typeof approvalId !== 'string' || !UUID.test(approvalId)) throw invalid();
    if (typeof consume.id !== 'string' || !UUID.test(consume.id)) throw invalid();
    const [current] = await this.db
      .select({ approval: approvals, planHash: plans.planHash })
      .from(approvals)
      .innerJoin(plans, eq(plans.id, approvals.planId))
      .where(eq(approvals.id, approvalId))
      .limit(1);
    if (!current || current.approval.planId !== consume.id) throw invalid();
    const { approval } = current;
    if (approval.decision === 'REJECT')
      throw forbidden('The plan was rejected by the approver.', 'approval_rejected');
    if (approval.decision !== 'APPROVE')
      throw forbidden('The plan has not been approved yet.', 'approval_pending');
    if (approval.planHash !== current.planHash) throw invalid();
    const result = await this.deps.plans.consume(consume);
    // Fail closed: a plan whose hash differs from the approved one is never executed.
    if (result.plan.planHash !== approval.planHash || result.plan.id !== approval.planId)
      throw invalid();
    return result;
  }

  /** Throws FORBIDDEN unless the user may decide this approval. Never consults the requester. */
  private async assertMayDecide(
    deciderId: string,
    approval: ApprovalRow,
    plan: PlanRow,
  ): Promise<void> {
    if (deciderId === approval.requestedBy || deciderId === plan.userId)
      throw forbidden('You cannot approve your own request.', 'self_approval');
    const [user] = await this.db
      .select({ active: users.active })
      .from(users)
      .where(eq(users.id, deciderId))
      .limit(1);
    if (!user?.active) throw forbidden('You cannot decide approvals.', 'inactive_user');
    const grants = await this.deps.authz.grants(deciderId);
    if (!grants.permissions.has('APPROVAL.DECIDE'))
      throw forbidden('You do not have permission to decide approvals.', 'permission_missing');
    if (!(await this.policyAllows(deciderId, plan)))
      throw forbidden('No policy allows you to approve this plan.', 'policy_denied');
  }

  /**
   * The decider needs a policy ALLOW for every action of the plan's capability on the entities
   * the statement touches (target plus tables it reads). The statement is re-classified from the
   * stored SQL; anything that does not classify as a write fails closed. The decider's RBAC gate
   * is APPROVAL.DECIDE, so the evaluation is given the plan's action as the only permission: the
   * policy rules alone decide whether this person may judge writes to those entities.
   */
  private async policyAllows(deciderId: string, plan: PlanRow): Promise<boolean> {
    const capability = plan.capability as { actions?: unknown } | null;
    const actions = Array.isArray(capability?.actions) ? capability.actions : [];
    if (actions.length === 0 || !actions.every((a) => typeof a === 'string' && isPermission(a)))
      return false;
    const classified = classifyStatement(plan.sql);
    if (
      classified.kind !== 'INSERT' &&
      classified.kind !== 'UPDATE' &&
      classified.kind !== 'DELETE'
    )
      return false;
    const entities = [...new Set([classified.table, ...classified.sourceTables])];
    const groupIds = await this.activeGroupsOf(deciderId);
    for (const action of actions as Permission[]) {
      const result = await this.deps.policies.evaluate(
        {
          userId: deciderId,
          groupIds,
          action,
          environment: plan.environment as Environment,
          connectionId: plan.connectionId,
          entities,
          hasWhere: classified.hasWhere,
        },
        new Set<Permission>([action]),
      );
      if (result.effect !== 'ALLOW') return false;
    }
    return true;
  }

  /** Groups that currently grant anything to the user (a disabled group grants nothing). */
  private async activeGroupsOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: groupMembers.groupId })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.active, true)));
    return rows.map((r) => r.id);
  }

  /** Why the conditional UPDATE of the approval matched nothing. */
  private async refusal(tx: Tx, approvalId: string, plan: PlanRow): Promise<AppError> {
    const [row] = await tx
      .select({ approval: approvals, expired: sql<boolean>`${approvals.expiresAt} <= now()` })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .limit(1);
    if (!row) return notFound();
    if (row.approval.decision !== null)
      return new AppError('CONFLICT', 'This approval was already decided.');
    if (row.approval.planHash !== plan.planHash) return invalid();
    if (row.expired) return expired();
    return invalid();
  }

  /** Why the plan transition matched nothing (the approval update is rolled back). */
  private async planRefusal(tx: Tx, planId: string): Promise<AppError> {
    const [row] = await tx
      .select({ status: plans.status, expired: sql<boolean>`${plans.expiresAt} <= now()` })
      .from(plans)
      .where(eq(plans.id, planId))
      .limit(1);
    if (row && (row.status === 'EXPIRED' || (row.status === 'PENDING' && row.expired)))
      return expired();
    return invalid();
  }

  private audit(db: Database | Tx): AuditService {
    return new AuditService(db as Database, this.deps.redact);
  }

  private auditBase(userId: string, context: ApprovalAuditContext) {
    return {
      userId,
      userEmail: context.userEmail ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    };
  }
}
