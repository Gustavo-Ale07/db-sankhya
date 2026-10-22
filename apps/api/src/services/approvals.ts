import { and, asc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { approvals, groupMembers, groups, plans, users } from '@dbx/database';
import type { ApprovalRow, Database, PlanRow } from '@dbx/database';
import {
  AppError,
  evaluatePolicy,
  isAppError,
  isPermission,
  statementPermission,
} from '@dbx/shared';
import type {
  EffectiveLimits,
  Environment,
  Permission,
  PolicyDecision,
  PolicyRequest,
} from '@dbx/shared';
import { classifyStatement } from '@dbx/sql-engine';
import type { AuthzService } from './authz';
import type { ConsumePlanInput, ConsumedPlan, PlansService } from './plans';
import {
  BUSINESS_ACTION_PERMISSION,
  actionEntities,
  parseActionStatement,
} from './business-actions';
import { SCRATCH_CONNECTION_ID } from './read-policy';
import { SCRATCH_TABLE_NAME } from './scratch-guard';
import type { PolicyService, PolicySnapshot } from './policy';
import { AuditService } from './records';

export type { ApprovalRow };
export type ApprovalDecision = 'APPROVE' | 'REJECT';

/** Request metadata copied to the audit rows. */
export interface ApprovalAuditContext {
  userEmail?: string;
  ip?: string;
  requestId?: string;
}

/**
 * A pending approval with what the decider needs to judge the plan. `sql` and `preview` are
 * present only when the decider may also read every entity of the plan (QUERY.SELECT plus a
 * policy that does not deny the read); otherwise only the summary is returned.
 */
export interface PendingApproval extends ApprovalRow {
  /** Display name of the requester (null when the account no longer exists). */
  requestedByName: string | null;
  plan: {
    environment: string;
    connectionId: string;
    previewKind: string;
    action: Permission;
    entities: string[];
    targetCount: number | null;
    sql?: string;
    preview?: unknown;
  };
}

export interface ApprovalsDeps {
  plans: PlansService;
  policies: PolicyService;
  authz: AuthzService;
  /** Redactor of the audit rows (the same one AuditService uses). */
  redact: (value: unknown) => unknown;
  /** Receives failures of the denied-audit writes (redacted); the refusal is still thrown. */
  logger?: { error(obj: object, msg: string): void };
  /**
   * The row ceilings the mutation orchestrator passes to the policy engine (SANKHYA_MAX_ROWS for
   * Sankhya plans, SCRATCH_MAX_ROWS for scratch plans). The approval checks must evaluate with
   * the same ceilings, or a frozen limit computed under them would look laxer than a fresh one.
   */
  ceilings?: { sankhyaMaxReadRows?: number; scratchMaxReadRows?: number };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Db = Database | Tx;

/** What a plan does, re-derived from its stored SQL and checked against its capability. */
interface PlanScope {
  /** Every permission the capability needs (includes `primary`). */
  actions: Permission[];
  primary: Permission;
  /** Target table plus the tables the statement reads. */
  entities: string[];
  hasWhere: boolean;
  /** Permissions that must also be held, without a policy of their own (business actions). */
  held?: Permission[];
}

/** Every permission a user must hold for the scope. */
const heldOf = (scope: PlanScope): Permission[] => [...scope.actions, ...(scope.held ?? [])];

/** A user as the checks see them, read once per call. */
interface Subject {
  id: string;
  active: boolean;
  permissions: ReadonlySet<Permission>;
  groupIds: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 1000;
const PENDING_LIMIT = 200;
/** Rows `listPending` reads at most; the filter then keeps up to PENDING_LIMIT of them. */
const PENDING_SCAN_LIMIT = 1000;
const BOOLEAN_GATES = [
  'requireWhere',
  'requirePreview',
  'requireConfirmation',
  'requireStrongConfirmation',
  'requireApproval',
] as const satisfies ReadonlyArray<keyof EffectiveLimits>;
const NUMERIC_GATES = ['maxReadRows', 'maxWriteRows'] as const satisfies ReadonlyArray<
  keyof EffectiveLimits
>;

const notFound = () => new AppError('NOT_FOUND', 'Approval not found');
const planNotFound = () => new AppError('NOT_FOUND', 'Plan not found');
const invalid = () =>
  new AppError('CONFIRMATION_INVALID', 'Invalid confirmation. Generate a new preview.');
const expired = () =>
  new AppError('CONFIRMATION_EXPIRED', 'The confirmation expired. Generate a new preview.');
const forbidden = (message: string, reason: string) =>
  new AppError('FORBIDDEN', message, { reason });

/**
 * Re-derives the plan's scope from its SQL. Fails closed (undefined) for anything that is not an
 * INSERT/UPDATE/DELETE, for generated DDL artifacts, and whenever the classified kind does not
 * match the frozen capability actions.
 */
function scopeOf(plan: PlanRow): PlanScope | undefined {
  const cap = plan.capability as {
    class?: unknown;
    route?: unknown;
    action?: unknown;
    actions?: unknown;
    blocked?: unknown;
  } | null;
  if (typeof cap !== 'object' || cap === null || cap.blocked) return undefined;
  if (cap.class !== 'SUPPORTED' && cap.class !== 'SCRATCH_ONLY') return undefined;
  if (cap.route === 'SANKHYA_ACTION') {
    // A business action plan: its statement must still parse to a registered action whose
    // own permission is the only frozen capability action; the generic one must be held too.
    const parsed = cap.class === 'SUPPORTED' ? parseActionStatement(plan.sql) : undefined;
    if (!parsed) return undefined;
    const perm = parsed.action.permission;
    const acts = cap.actions;
    if (cap.action !== perm || !Array.isArray(acts) || acts.length !== 1 || acts[0] !== perm)
      return undefined;
    return {
      actions: [perm],
      primary: perm,
      entities: actionEntities(parsed.action),
      hasWhere: true,
      held: [BUSINESS_ACTION_PERMISSION],
    };
  }
  if (cap.route !== 'SANKHYA_SAVE' && cap.route !== 'SCRATCH' && cap.route !== 'HYBRID')
    return undefined;
  const actions = cap.actions;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    !actions.every((a): a is Permission => typeof a === 'string' && isPermission(a))
  )
    return undefined;
  const classified = classifyStatement(plan.sql);
  if (classified.kind !== 'INSERT' && classified.kind !== 'UPDATE' && classified.kind !== 'DELETE')
    return undefined;
  // A scratch route only ever writes a scratch table; anything else is mislabelled.
  if (cap.route !== 'SANKHYA_SAVE' && !SCRATCH_TABLE_NAME.test(classified.table)) return undefined;
  const primary: Permission =
    cap.route === 'SANKHYA_SAVE' ? statementPermission(classified.kind) : 'TEMP.WRITE';
  const allowed: Permission[] =
    cap.route === 'SANKHYA_SAVE' ? [primary] : [primary, 'TEMP.MATERIALIZE', 'QUERY.SELECT'];
  if (cap.action !== primary || !actions.includes(primary)) return undefined;
  if (!actions.every((a) => allowed.includes(a))) return undefined;
  return {
    actions: [...new Set(actions)],
    primary,
    entities: [...new Set([classified.table, ...classified.sourceTables])],
    // An INSERT has no WHERE to give (the TEMP.WRITE rule only asks UPDATE and DELETE for one).
    hasWhere: classified.kind === 'INSERT' || classified.hasWhere,
  };
}

/**
 * `evaluatePolicy` over a freshly loaded rule set, failing closed like `PolicyService.evaluate`:
 * no snapshot, an invalid enabled rule or a throw all deny. Returns the decision only on ALLOW.
 */
function allowedBy(
  snapshot: PolicySnapshot | undefined,
  req: PolicyRequest,
  permissions: ReadonlySet<Permission>,
  defaults?: { maxReadRows?: number },
): PolicyDecision | undefined {
  if (!snapshot || snapshot.invalid.length > 0) return undefined;
  try {
    const decision = evaluatePolicy(req, snapshot.rules, new Set(permissions), {
      policyVersion: snapshot.version,
      ...(defaults ? { defaults } : {}),
    });
    return decision.effect === 'ALLOW' ? decision : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when the frozen gates are at least as strict as the current ones: every gate the current
 * policy turns on is on in the plan, and no frozen row ceiling exceeds the current one.
 */
export function gatesHold(fresh: EffectiveLimits, plan: PlanRow): boolean {
  const frozen = (plan.decision as { limits?: Record<string, unknown> } | null)?.limits;
  if (typeof frozen !== 'object' || frozen === null) return false;
  for (const gate of BOOLEAN_GATES) {
    if (typeof frozen[gate] !== 'boolean') return false;
    if (fresh[gate] && frozen[gate] !== true) return false;
  }
  for (const gate of NUMERIC_GATES) {
    const value = frozen[gate];
    if (typeof value !== 'number' || value > fresh[gate]) return false;
  }
  if (fresh.requireStrongConfirmation && plan.strongConfirmationPhrase === null) return false;
  if (Array.isArray(plan.targets) && plan.targets.length > fresh.maxWriteRows) return false;
  return true;
}

/**
 * Four-eyes approvals bound to the plan hash (Task 14.1).
 *
 * - `request`: the plan owner, holding every capability action, asks for approval of a live
 *   plan that requires one and whose SQL classifies as a write matching its capability. The
 *   approval copies `plan_hash` and the plan's `expires_at`, so it expires together with it.
 * - `decide`: inside one transaction (approval row locked), the decider must not be the
 *   requester, must be active, hold APPROVAL.DECIDE and every capability action in their own
 *   grants, and get a policy ALLOW for each action on each entity from a freshly loaded rule set.
 *   The approval row and then the plan move through conditional UPDATEs (decision still empty,
 *   hash equal, not expired), so of two racing deciders exactly one wins; the other gets
 *   CONFLICT. APPROVE moves the plan to APPROVED (which `PlansService` also ties to this row);
 *   REJECT moves it to INVALIDATED, so it can never be consumed. Every outcome is audited.
 * - `consumeApproved` is the execution boundary for plans that require approval: the mutation
 *   executor reaches it through `consumeForPlan` and never calls `PlansService.consume` for them.
 *   A rejected or still pending approval gives FORBIDDEN; so does a requester who is no longer
 *   active, lost a capability permission, or whose current policy denies the plan or demands
 *   stricter gates than the frozen ones (audited). An approval of another plan, or whose hash no
 *   longer equals the plan's, gives CONFIRMATION_INVALID. Everything else (invalidated, expired,
 *   used plan) is reported by `PlansService.consume` as usual.
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
    const scope = scopeOf(plan);
    if (!scope)
      throw new AppError('VALIDATION_ERROR', 'This plan cannot be submitted for approval.');
    // Only an owner who could run the plan may queue it for a second person: a plan previewed
    // through DATA.PREVIEW alone is refused at execution, so it never reaches an approver.
    const grants = await this.deps.authz.grants(userId);
    if (!heldOf(scope).every((a) => grants.permissions.has(a)))
      throw new AppError('FORBIDDEN', 'You do not have permission for this action');
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
   * Records the decision, or throws: NOT_FOUND, VALIDATION_ERROR, FORBIDDEN (self-approval,
   * inactive, missing permission, no policy ALLOW), CONFLICT (already decided),
   * CONFIRMATION_EXPIRED or CONFIRMATION_INVALID (plan no longer live, or its hash differs).
   * The success audit row is written in the transaction; any refusal other than VALIDATION_ERROR
   * is audited as `denied` (with its error code) after the transaction rolled back.
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
    const details: Record<string, unknown> = { approvalId, decision };
    try {
      if (typeof approvalId !== 'string' || !UUID.test(approvalId)) throw notFound();
      if (typeof deciderId !== 'string' || !UUID.test(deciderId)) throw notFound();
      // Read before the transaction: an embedded single-connection database cannot serve a
      // second query while the transaction holds it.
      const snapshot = await this.freshPolicies();
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ approval: approvals, plan: plans })
          .from(approvals)
          .innerJoin(plans, eq(plans.id, approvals.planId))
          .where(eq(approvals.id, approvalId))
          .limit(1)
          .for('update');
        if (!current) throw notFound();
        const { approval, plan } = current;
        Object.assign(details, { planId: plan.id, planHash: approval.planHash });
        if (approval.decision !== null)
          throw new AppError('CONFLICT', 'This approval was already decided.');
        const subject = await this.subject(deciderId, tx);
        this.assertDecider(subject, approval, plan, snapshot);

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
        // The plan moves in the same transaction; if it is no longer a live PENDING plan with
        // the approved hash, the whole decision is rolled back.
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
    } catch (err) {
      if (isAppError(err) && err.code !== 'VALIDATION_ERROR') {
        await this.auditDenied(err, {
          ...this.auditBase(UUID.test(String(deciderId)) ? deciderId : null, context),
          action: 'approval.decide',
          details: { ...details, reason: err.details?.reason },
        });
      }
      throw err;
    }
  }

  /** Undecided, unexpired approvals the user may decide (never their own requests). */
  async listPending(forUserId: string): Promise<PendingApproval[]> {
    if (typeof forUserId !== 'string' || !UUID.test(forUserId)) return [];
    const subject = await this.subject(forUserId, this.db);
    if (!subject?.active || !subject.permissions.has('APPROVAL.DECIDE')) return [];
    const snapshot = await this.freshPolicies();
    const rows = await this.db
      .select({ approval: approvals, plan: plans, requesterName: users.name })
      .from(approvals)
      .innerJoin(plans, eq(plans.id, approvals.planId))
      .leftJoin(users, eq(users.id, approvals.requestedBy))
      .where(
        and(
          isNull(approvals.decision),
          gt(approvals.expiresAt, sql`now()`),
          ne(approvals.requestedBy, forUserId),
          ne(plans.userId, forUserId),
          eq(plans.status, 'PENDING'),
          gt(plans.expiresAt, sql`now()`),
        ),
      )
      .orderBy(asc(approvals.createdAt), asc(approvals.id))
      .limit(PENDING_SCAN_LIMIT);
    // Filter first, then limit: approvals the user cannot decide never take a slot.
    const out: PendingApproval[] = [];
    for (const { approval, plan, requesterName } of rows) {
      if (out.length >= PENDING_LIMIT) break;
      if (approval.planHash !== plan.planHash) continue;
      let scope: PlanScope;
      try {
        scope = this.assertDecider(subject, approval, plan, snapshot);
      } catch {
        continue;
      }
      const readable = this.mayRead(subject, plan, scope, snapshot);
      out.push({
        ...approval,
        requestedByName: requesterName ?? null,
        plan: {
          environment: plan.environment,
          connectionId: plan.connectionId,
          previewKind: plan.previewKind,
          action: scope.primary,
          entities: scope.entities,
          targetCount: Array.isArray(plan.targets) ? plan.targets.length : null,
          ...(readable ? { sql: plan.sql, preview: plan.preview } : {}),
        },
      });
    }
    return out;
  }

  /**
   * Execution boundary of a plan that requires approval (see the class comment). The approval
   * must belong to this plan, be APPROVE, and carry the plan's current hash; the requester is
   * re-checked against current grants and policies; the plan is then consumed by
   * `PlansService.consume`, whose result is checked against the hash once more.
   */
  async consumeApproved(input: ConsumePlanInput & { approvalId: string }): Promise<ConsumedPlan> {
    const { approvalId, ...consume } = input;
    if (typeof approvalId !== 'string' || !UUID.test(approvalId)) throw invalid();
    if (typeof consume.id !== 'string' || !UUID.test(consume.id)) throw invalid();
    const [current] = await this.db
      .select({ approval: approvals, plan: plans })
      .from(approvals)
      .innerJoin(plans, eq(plans.id, approvals.planId))
      .where(eq(approvals.id, approvalId))
      .limit(1);
    if (!current || current.approval.planId !== consume.id) throw invalid();
    const { approval, plan } = current;
    if (approval.planHash !== plan.planHash) throw invalid();
    try {
      if (approval.decision === 'REJECT')
        throw forbidden('The plan was rejected by the approver.', 'approval_rejected');
      if (approval.decision !== 'APPROVE')
        throw forbidden('The plan has not been approved yet.', 'approval_pending');
      await this.assertRequester(plan);
    } catch (err) {
      if (isAppError(err) && err.code === 'FORBIDDEN') {
        await this.auditDenied(err, {
          ...this.auditBase(plan.userId, {}),
          action: 'approval.execute',
          details: {
            approvalId,
            planId: plan.id,
            planHash: plan.planHash,
            reason: err.details?.reason,
          },
        });
      }
      throw err;
    }
    const result = await this.deps.plans.consume(consume);
    // Fail closed: a plan whose hash differs from the approved one is never executed.
    if (result.plan.planHash !== approval.planHash || result.plan.id !== approval.planId)
      throw invalid();
    return result;
  }

  /**
   * The approval path of the mutation executor: finds the approval of `input.id` and runs
   * `consumeApproved` with it. A plan nobody has asked approval for yet is refused (FORBIDDEN,
   * audited) without touching the plan, exactly like a pending approval.
   */
  async consumeForPlan(input: ConsumePlanInput): Promise<ConsumedPlan & { approvalId: string }> {
    if (typeof input.id !== 'string' || !UUID.test(input.id)) throw invalid();
    const [row] = await this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.planId, input.id))
      .limit(1);
    if (!row) {
      const err = forbidden('The plan has not been approved yet.', 'approval_pending');
      await this.auditDenied(err, {
        ...this.auditBase(UUID.test(String(input.userId)) ? input.userId : null, {}),
        action: 'approval.execute',
        details: { planId: input.id, reason: 'approval_pending' },
      });
      throw err;
    }
    const result = await this.consumeApproved({ ...input, approvalId: row.id });
    return { ...result, approvalId: row.id };
  }

  /**
   * Throws FORBIDDEN unless the subject may decide this approval; returns the plan scope. The
   * decider needs APPROVAL.DECIDE and every capability action in their own grants (so a role
   * without DATA.* never approves ERP writes, whatever an `everyone` rule says), plus a policy
   * ALLOW for each action on each entity.
   */
  private assertDecider(
    subject: Subject | undefined,
    approval: ApprovalRow,
    plan: PlanRow,
    snapshot: PolicySnapshot | undefined,
  ): PlanScope {
    if (subject?.id === approval.requestedBy || subject?.id === plan.userId)
      throw forbidden('You cannot approve your own request.', 'self_approval');
    if (!subject?.active) throw forbidden('You cannot decide approvals.', 'inactive_user');
    if (!subject.permissions.has('APPROVAL.DECIDE'))
      throw forbidden('You do not have permission to decide approvals.', 'permission_missing');
    const scope = scopeOf(plan);
    if (!scope) throw forbidden('This plan cannot be approved.', 'plan_undecidable');
    if (!heldOf(scope).every((a) => subject.permissions.has(a)))
      throw forbidden('You do not hold every permission this plan needs.', 'permission_missing');
    for (const action of scope.actions) {
      for (const entity of scope.entities) {
        if (
          !allowedBy(
            snapshot,
            this.policyRequest(subject, plan, scope, action, [entity]),
            subject.permissions,
            this.defaultsFor(plan),
          )
        )
          throw forbidden('No policy allows you to approve this plan.', 'policy_denied');
      }
    }
    return scope;
  }

  /** The decider may see the statement and preview only if they may read every entity. */
  private mayRead(
    subject: Subject,
    plan: PlanRow,
    scope: PlanScope,
    snapshot: PolicySnapshot | undefined,
  ): boolean {
    if (!subject.permissions.has('QUERY.SELECT')) return false;
    return scope.entities.every(
      (entity) =>
        allowedBy(
          snapshot,
          this.policyRequest(subject, plan, scope, 'QUERY.SELECT', [entity]),
          subject.permissions,
          this.defaultsFor(plan),
        ) !== undefined,
    );
  }

  /** Re-checks the plan owner at execution time; throws FORBIDDEN on any failure. */
  private async assertRequester(plan: PlanRow): Promise<void> {
    const subject = await this.subject(plan.userId, this.db);
    if (!subject?.active)
      throw forbidden('The requester is no longer active.', 'requester_inactive');
    const scope = scopeOf(plan);
    if (!scope) throw forbidden('This plan cannot be executed.', 'plan_undecidable');
    if (!heldOf(scope).every((a) => subject.permissions.has(a)))
      throw forbidden(
        'The requester no longer holds the permissions this plan needs.',
        'requester_permission_missing',
      );
    const snapshot = await this.freshPolicies();
    for (const action of scope.actions) {
      const decision = allowedBy(
        snapshot,
        this.policyRequest(subject, plan, scope, action, scope.entities),
        subject.permissions,
        this.defaultsFor(plan),
      );
      if (!decision)
        throw forbidden(
          'The current policy no longer allows this plan.',
          'requester_policy_denied',
        );
      if (action === scope.primary && !gatesHold(decision.limits, plan))
        throw forbidden(
          'The current policy is stricter than this plan.',
          'requester_gates_stricter',
        );
    }
  }

  private policyRequest(
    subject: Subject,
    plan: PlanRow,
    scope: PlanScope,
    action: Permission,
    entities: string[],
  ): PolicyRequest {
    return {
      userId: subject.id,
      groupIds: subject.groupIds,
      action,
      environment: plan.environment as Environment,
      connectionId: plan.connectionId,
      entities,
      hasWhere: scope.hasWhere,
    };
  }

  /** The row ceiling the orchestrator evaluated this plan with (see `ApprovalsDeps.ceilings`). */
  private defaultsFor(plan: PlanRow): { maxReadRows: number } | undefined {
    const ceilings = this.deps.ceilings;
    const maxReadRows =
      plan.connectionId === SCRATCH_CONNECTION_ID
        ? ceilings?.scratchMaxReadRows
        : ceilings?.sankhyaMaxReadRows;
    return maxReadRows === undefined ? undefined : { maxReadRows };
  }

  /** The rule set re-read from the database; undefined (deny everything) when it cannot be. */
  private async freshPolicies(): Promise<PolicySnapshot | undefined> {
    try {
      return await this.deps.policies.load();
    } catch {
      return undefined;
    }
  }

  /** Activity, current grants and active groups (a disabled group grants nothing). */
  private async subject(userId: string, db: Db): Promise<Subject | undefined> {
    const [user] = await db
      .select({ active: users.active })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) return undefined;
    const grants = await this.deps.authz.grants(userId, db);
    const memberships = await db
      .select({ id: groupMembers.groupId })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.active, true)));
    return {
      id: userId,
      active: user.active,
      permissions: grants.permissions,
      groupIds: memberships.map((m) => m.id),
    };
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

  /**
   * Writes a `denied` audit row for a refusal. Never throws: the caller always rethrows the
   * original error, and a failed write is only logged (redacted, without the row's contents).
   */
  private async auditDenied(
    err: AppError,
    row: ReturnType<ApprovalsService['auditBase']> & {
      action: string;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.audit(this.db).record({
        ...row,
        status: 'denied',
        resource: 'plan',
        errorCode: err.code,
        errorMessage: err.message,
      });
    } catch (auditErr) {
      let detail: unknown;
      try {
        detail = this.deps.redact({
          message: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      } catch {
        detail = undefined;
      }
      try {
        this.deps.logger?.error(
          {
            action: row.action,
            errorCode: err.code,
            requestId: row.requestId,
            auditError: auditErr instanceof Error ? auditErr.name : typeof auditErr,
            detail,
          },
          'Approval audit write failed',
        );
      } catch {
        // Logging must not mask the refusal either.
      }
    }
  }

  private audit(db: Db): AuditService {
    return new AuditService(db as Database, this.deps.redact);
  }

  private auditBase(userId: string | null, context: ApprovalAuditContext) {
    return {
      userId,
      userEmail: context.userEmail ?? null,
      ip: context.ip ?? null,
      requestId: context.requestId ?? null,
    };
  }
}
