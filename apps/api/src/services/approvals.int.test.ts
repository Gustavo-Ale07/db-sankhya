import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  approvals,
  auditEvents,
  createDatabase,
  plans,
  policies,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { DEFAULT_LIMITS, isAppError } from '@dbx/shared';
import type { ErrorCode, Permission, PolicyDecision } from '@dbx/shared';
import type { Capability } from '@dbx/sql-engine';
import { ApprovalsService } from './approvals';
import { AuthzService } from './authz';
import { PlansService } from './plans';
import type { CreatedPlan, NewPlan } from './plans';
import { PolicyService } from './policy';

const SECRET = 'approval-test-secret-fixture-0123456789ab';
const TTL = 300;
const APPROVAL_TTL = 3600;

let database: DatabaseHandle;
let requester: string;
let decider: string;
let decider2: string;
let noPolicy: string;
let noPermission: string;
let sessionId: string;
let plansService: PlansService;
let policyService: PolicyService;
let service: ApprovalsService;

const silent = { error: () => undefined, warn: () => undefined };

async function addUser(email: string, ...roleKeys: string[]): Promise<string> {
  const [row] = await database.db
    .insert(users)
    .values({ email, name: email.split('@')[0]!, passwordHash: 'x' })
    .returning({ id: users.id });
  for (const roleKey of roleKeys) {
    const [role] = await database.db.select().from(roles).where(eq(roles.key, roleKey));
    await database.db.insert(userRoles).values({ userId: row!.id, roleId: role!.id });
  }
  return row!.id;
}

/** A custom role holding exactly these permissions. */
async function addRole(key: string, permissions: Permission[]): Promise<void> {
  const [role] = await database.db
    .insert(roles)
    .values({ key, name: key })
    .returning({ id: roles.id });
  await database.db
    .insert(rolePermissions)
    .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
}

async function rule(
  effect: 'ALLOW' | 'DENY',
  subjectId: string | null,
  actions: Permission[],
  entities = ['TGFPAR'],
  limits: Record<string, unknown> = {},
): Promise<void> {
  await database.db.insert(policies).values({
    name: `${effect} ${subjectId ?? 'everyone'} ${actions.join(',')}`,
    effect,
    subjectType: subjectId ? 'user' : 'everyone',
    subjectId,
    actions,
    entities,
    limits,
  });
  policyService.invalidate();
}

const allow = (userId: string, entities = ['TGFPAR']) =>
  rule('ALLOW', userId, ['DATA.UPDATE'], entities);

beforeEach(async () => {
  database = await createDatabase('pglite:memory');
  await database.migrate();
  // The requester holds APPROVAL.DECIDE and a policy too: only the four-eyes rule stops them.
  // ADMIN alone has no DATA.*, so deciders of ERP writes also hold OPERATOR.
  requester = await addUser('ana@example.com', 'ADMIN', 'OPERATOR');
  decider = await addUser('bia@example.com', 'ADMIN', 'OPERATOR');
  decider2 = await addUser('caio@example.com', 'ADMIN', 'OPERATOR');
  noPolicy = await addUser('duda@example.com', 'ADMIN', 'OPERATOR');
  noPermission = await addUser('edu@example.com', 'OPERATOR');
  sessionId = randomUUID();
  policyService = new PolicyService(database.db, silent);
  for (const u of [requester, decider, decider2, noPermission]) await allow(u);
  plansService = new PlansService(database.db, {
    secret: SECRET,
    ttlSeconds: TTL,
    approvalTtlSeconds: APPROVAL_TTL,
  });
  service = new ApprovalsService(database.db, {
    plans: plansService,
    policies: policyService,
    authz: new AuthzService(database.db),
    redact: (v) => v,
  });
});

afterEach(async () => {
  await database.close();
});

const CAPABILITY: Capability = {
  class: 'SUPPORTED',
  route: 'SANKHYA_SAVE',
  reason: 'update through the gateway',
  action: 'DATA.UPDATE',
  actions: ['DATA.UPDATE'],
};

const decision = (requireApproval = true): PolicyDecision => ({
  effect: 'ALLOW',
  reasons: [],
  matchedRuleIds: ['r1'],
  // What evaluatePolicy freezes for an UPDATE with WHERE (requireWhere), plus the approval gate.
  limits: { ...DEFAULT_LIMITS, requireWhere: true, requireApproval },
  policyVersion: 'a'.repeat(64),
});

function newPlan(over: Partial<NewPlan> = {}): NewPlan {
  return {
    userId: requester,
    sessionId,
    connectionId: 'env-default',
    environment: 'SANDBOX',
    sql: "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC IN (1, 2)",
    params: [],
    capability: CAPABILITY,
    decision: decision(),
    targets: [
      { key: { CODPARC: 1 }, before: { NOMEPARC: 'A' } },
      { key: { CODPARC: 2 }, before: { NOMEPARC: 'B' } },
    ],
    preview: { rows: 2 },
    previewKind: 'UPDATE_DIFF',
    summary: { action: 'UPDATE', count: 2, entity: 'TGFPAR' },
    ...over,
  };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isAppError(err) ? err.code : err).toBe(code);
}

const execute = (plan: CreatedPlan, approvalId: string) =>
  service.consumeApproved({
    id: plan.id,
    token: plan.token,
    userId: requester,
    sessionId,
    approvalId,
  });

const planStatus = async (id: string) =>
  (await database.db.select({ s: plans.status }).from(plans).where(eq(plans.id, id)))[0]?.s;

const auditRows = (action: string) =>
  database.db.select().from(auditEvents).where(eq(auditEvents.action, action));

describe('ApprovalsService.request', () => {
  it('binds the approval to the plan hash and the plan expiry', async () => {
    const before = Date.now();
    const plan = await plansService.create(newPlan());
    // Plans requiring approval live APPROVAL_TTL_MINUTES instead of PLAN_TTL_SECONDS.
    expect(plan.expiresAt.getTime()).toBeGreaterThanOrEqual(before + APPROVAL_TTL * 1000);

    const approval = await service.request(plan.id, requester);
    expect(approval).toMatchObject({
      planId: plan.id,
      planHash: plan.planHash,
      requestedBy: requester,
      decidedBy: null,
      decision: null,
      reason: null,
      decidedAt: null,
    });
    expect(approval.expiresAt.getTime()).toBe(plan.expiresAt.getTime());
    expect(await auditRows('approval.request')).toHaveLength(1);
  });

  it('keeps PLAN_TTL_SECONDS for plans that do not require approval', async () => {
    const plan = await plansService.create(newPlan({ decision: decision(false) }));
    expect(plan.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TTL * 1000);
    await expectCode(service.request(plan.id, requester), 'VALIDATION_ERROR');
  });

  it('returns the same approval when asked twice', async () => {
    const plan = await plansService.create(newPlan());
    const a = await service.request(plan.id, requester);
    const b = await service.request(plan.id, requester);
    expect(b.id).toBe(a.id);
    expect(await database.db.select().from(approvals)).toHaveLength(1);
  });

  it('only lets the plan owner ask, and only for a live plan', async () => {
    const plan = await plansService.create(newPlan());
    await expectCode(service.request(plan.id, decider), 'NOT_FOUND');
    await expectCode(service.request(randomUUID(), requester), 'NOT_FOUND');
    await expectCode(service.request('not-a-uuid', requester), 'NOT_FOUND');
    await plansService.invalidateForConnection('env-default');
    await expectCode(service.request(plan.id, requester), 'CONFIRMATION_INVALID');
  });

  it('refuses an expired plan', async () => {
    const past = new PlansService(database.db, {
      secret: SECRET,
      ttlSeconds: TTL,
      approvalTtlSeconds: APPROVAL_TTL,
      now: () => new Date(Date.now() - 2 * APPROVAL_TTL * 1000),
    });
    const plan = await past.create(newPlan());
    await expectCode(service.request(plan.id, requester), 'CONFIRMATION_EXPIRED');
  });
});

describe('ApprovalsService.decide', () => {
  it('refuses self-approval with FORBIDDEN and audits the attempt', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expectCode(service.decide(approval.id, requester, 'APPROVE', null), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('PENDING');
    const rows = await auditRows('approval.decide');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN', userId: requester });
  });

  it('approves, and the approved plan can then be executed once', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    const decided = await service.decide(approval.id, decider, 'APPROVE', 'looks right');
    expect(decided).toMatchObject({
      decision: 'APPROVE',
      decidedBy: decider,
      reason: 'looks right',
    });
    expect(decided.decidedAt).toBeInstanceOf(Date);
    expect(await planStatus(plan.id)).toBe('APPROVED');

    const { plan: row, replayed } = await execute(plan, approval.id);
    expect(replayed).toBe(false);
    expect(row.status).toBe('CONSUMED');
    await expectCode(execute(plan, approval.id), 'CONFIRMATION_USED');

    const rows = await auditRows('approval.decide');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'success', userId: decider });
    expect(rows[0]!.details).toMatchObject({
      approvalId: approval.id,
      planId: plan.id,
      planHash: plan.planHash,
      decision: 'APPROVE',
    });
  });

  it('rejects, and execution then fails with FORBIDDEN', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    const decided = await service.decide(approval.id, decider, 'REJECT', 'wrong rows');
    expect(decided.decision).toBe('REJECT');
    expect(await planStatus(plan.id)).toBe('INVALIDATED');

    await expectCode(execute(plan, approval.id), 'FORBIDDEN');
    // Nor can the plan be consumed bypassing the approval boundary.
    await expectCode(
      plansService.consume({ id: plan.id, token: plan.token, userId: requester, sessionId }),
      'CONFIRMATION_INVALID',
    );
    // A rejection is final.
    await expectCode(service.decide(approval.id, decider2, 'APPROVE', null), 'CONFLICT');
  });

  it('cannot execute while the approval is still pending', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expectCode(execute(plan, approval.id), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('PENDING');
  });

  it('makes the approval unusable once the plan is invalidated (connection rotated)', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await service.decide(approval.id, decider, 'APPROVE', null);
    await plansService.invalidateForConnection('env-default');
    await expectCode(execute(plan, approval.id), 'CONFIRMATION_INVALID');

    const other = await plansService.create(newPlan());
    const pending = await service.request(other.id, requester);
    await plansService.invalidateForConnection('env-default');
    await expectCode(service.decide(pending.id, decider, 'APPROVE', null), 'CONFIRMATION_INVALID');
    const [row] = await database.db.select().from(approvals).where(eq(approvals.id, pending.id));
    expect(row!.decision).toBeNull();
  });

  it('refuses a decider without a policy ALLOW for the entity', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expectCode(service.decide(approval.id, noPolicy, 'APPROVE', null), 'FORBIDDEN');

    // A policy for another entity does not count either.
    await allow(noPolicy, ['TGFPRO']);
    await expectCode(service.decide(approval.id, noPolicy, 'APPROVE', null), 'FORBIDDEN');

    // A DENY rule wins over the decider's ALLOW.
    await database.db.insert(policies).values({
      name: 'deny bia',
      effect: 'DENY',
      subjectType: 'user',
      subjectId: decider,
      actions: ['DATA.UPDATE'],
      entities: ['TGFPAR'],
    });
    policyService.invalidate();
    await expectCode(service.decide(approval.id, decider, 'APPROVE', null), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('PENDING');
  });

  it('refuses a decider without APPROVAL.DECIDE, an inactive decider or unknown input', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expectCode(service.decide(approval.id, noPermission, 'APPROVE', null), 'FORBIDDEN');
    await database.db.update(users).set({ active: false }).where(eq(users.id, decider));
    await expectCode(service.decide(approval.id, decider, 'APPROVE', null), 'FORBIDDEN');
    await expectCode(
      service.decide(approval.id, decider2, 'MAYBE' as 'APPROVE', null),
      'VALIDATION_ERROR',
    );
    await expectCode(
      service.decide(approval.id, decider2, 'APPROVE', 'x'.repeat(1001)),
      'VALIDATION_ERROR',
    );
    await expectCode(service.decide(randomUUID(), decider2, 'APPROVE', null), 'NOT_FOUND');
    await expectCode(service.decide('nope', decider2, 'APPROVE', null), 'NOT_FOUND');
    expect(await planStatus(plan.id)).toBe('PENDING');
  });

  it('refuses an approval reused for a different plan with CONFIRMATION_INVALID', async () => {
    const a = await plansService.create(newPlan());
    const b = await plansService.create(newPlan());
    const approvalA = await service.request(a.id, requester);
    const approvalB = await service.request(b.id, requester);
    await service.decide(approvalA.id, decider, 'APPROVE', null);
    await service.decide(approvalB.id, decider, 'APPROVE', null);
    await expectCode(execute(b, approvalA.id), 'CONFIRMATION_INVALID');
    await expectCode(execute(b, randomUUID()), 'CONFIRMATION_INVALID');
    await expectCode(execute(b, 'not-a-uuid'), 'CONFIRMATION_INVALID');
    expect(await planStatus(b.id)).toBe('APPROVED');
    await execute(b, approvalB.id);
  });

  it('refuses an approval whose plan hash does not match the plan', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await database.db
      .update(approvals)
      .set({ planHash: 'f'.repeat(64) })
      .where(eq(approvals.id, approval.id));
    await expectCode(service.decide(approval.id, decider, 'APPROVE', null), 'CONFIRMATION_INVALID');
    expect(await planStatus(plan.id)).toBe('PENDING');

    // Approved, then the stored hash is altered: execution refuses and the plan is not consumed.
    const other = await plansService.create(newPlan());
    const ok = await service.request(other.id, requester);
    await service.decide(ok.id, decider, 'APPROVE', null);
    await database.db
      .update(approvals)
      .set({ planHash: 'f'.repeat(64) })
      .where(eq(approvals.id, ok.id));
    await expectCode(execute(other, ok.id), 'CONFIRMATION_INVALID');
    expect(await planStatus(other.id)).toBe('APPROVED');
  });

  it('refuses a decision after the approval expired', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await database.db
      .update(approvals)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(approvals.id, approval.id));
    await expectCode(service.decide(approval.id, decider, 'APPROVE', null), 'CONFIRMATION_EXPIRED');
    expect(await planStatus(plan.id)).toBe('PENDING');
  });

  it('records exactly one decision when two deciders race', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    const results = await Promise.allSettled([
      service.decide(approval.id, decider, 'APPROVE', null),
      service.decide(approval.id, decider2, 'REJECT', null),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isAppError(rejected.reason) && rejected.reason.code).toBe('CONFLICT');

    const [row] = await database.db.select().from(approvals).where(eq(approvals.id, approval.id));
    const winner = (fulfilled[0] as PromiseFulfilledResult<{ decision: string }>).value;
    expect(row!.decision).toBe(winner.decision);
    expect(await planStatus(plan.id)).toBe(
      winner.decision === 'APPROVE' ? 'APPROVED' : 'INVALIDATED',
    );
    const audits = await database.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'approval.decide'), eq(auditEvents.status, 'success')));
    expect(audits).toHaveLength(1);
  });

  it('enforces four eyes in the database too', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expect(
      database.db
        .update(approvals)
        .set({ decision: 'APPROVE', decidedBy: requester, decidedAt: sql`now()` })
        .where(eq(approvals.id, approval.id)),
    ).rejects.toThrow();
  });
});

describe('ApprovalsService.request: plan scope', () => {
  it('refuses plans whose SQL is not a write matching the capability', async () => {
    const ddl = await plansService.create(
      newPlan({
        sql: 'CREATE TABLE AD_X (ID INT)',
        capability: {
          class: 'SUPPORTED_VIA_GENERATED_ARTIFACT',
          route: 'DDL_ARTIFACT',
          reason: 'custom table',
          action: 'DDL.CUSTOM.GENERATE',
          actions: ['DDL.CUSTOM.GENERATE'],
        },
      }),
    );
    await expectCode(service.request(ddl.id, requester), 'VALIDATION_ERROR');
    const garbage = await plansService.create(newPlan({ sql: 'this is not sql' }));
    await expectCode(service.request(garbage.id, requester), 'VALIDATION_ERROR');
    // The SQL is an INSERT but the frozen capability says DATA.UPDATE.
    const mismatch = await plansService.create(
      newPlan({ sql: "INSERT INTO TGFPAR (CODPARC, NOMEPARC) VALUES (3, 'C')" }),
    );
    await expectCode(service.request(mismatch.id, requester), 'VALIDATION_ERROR');
    expect(await database.db.select().from(approvals)).toHaveLength(0);
  });
});

describe('ApprovalsService.decide: the decider holds every capability permission', () => {
  it('never lets ADMIN alone approve an ERP write, even with an everyone ALLOW rule', async () => {
    const adminOnly = await addUser('fabi@example.com', 'ADMIN');
    await rule('ALLOW', null, ['DATA.UPDATE']);
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await expectCode(service.decide(approval.id, adminOnly, 'APPROVE', null), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('PENDING');
    expect(await service.listPending(adminOnly)).toEqual([]);
    const [row] = await auditRows('approval.decide');
    expect(row).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN', userId: adminOnly });
    expect(row!.details).toMatchObject({ reason: 'permission_missing' });
  });

  it('requires TEMP and QUERY permissions for a scratch plan reading the ERP', async () => {
    await addRole('SCRATCH_APPROVER', ['APPROVAL.DECIDE', 'TEMP.WRITE']);
    const partial = await addUser('gabi@example.com', 'SCRATCH_APPROVER');
    const plan = await plansService.create(
      newPlan({
        sql: 'INSERT INTO tmp_x SELECT CODPARC FROM TGFPAR',
        capability: {
          class: 'SCRATCH_ONLY',
          route: 'HYBRID',
          reason: 'scratch from ERP rows',
          action: 'TEMP.WRITE',
          actions: ['TEMP.WRITE', 'TEMP.MATERIALIZE', 'QUERY.SELECT'],
        },
        previewKind: 'INSERT_ROWS',
      }),
    );
    const approval = await service.request(plan.id, requester);
    await expectCode(service.decide(approval.id, partial, 'APPROVE', null), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('PENDING');
    // ADMIN holds QUERY.SELECT and TEMP.*: enough for a scratch plan.
    const admin = await addUser('hugo@example.com', 'ADMIN');
    await service.decide(approval.id, admin, 'APPROVE', null);
    expect(await planStatus(plan.id)).toBe('APPROVED');
  });

  it('audits refusals other than FORBIDDEN with their error code', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await service.decide(approval.id, decider, 'APPROVE', null);
    await expectCode(service.decide(approval.id, decider2, 'REJECT', null), 'CONFLICT');
    await expectCode(service.decide(randomUUID(), decider2, 'APPROVE', null), 'NOT_FOUND');
    const denied = await database.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'approval.decide'), eq(auditEvents.status, 'denied')));
    expect(denied.map((r) => r.errorCode).sort()).toEqual(['CONFLICT', 'NOT_FOUND']);
    expect(denied.every((r) => r.userId === decider2)).toBe(true);
  });
});

describe('ApprovalsService.consumeApproved: the requester is re-checked', () => {
  async function approved(): Promise<{ plan: CreatedPlan; approvalId: string }> {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await service.decide(approval.id, decider, 'APPROVE', null);
    return { plan, approvalId: approval.id };
  }

  async function expectRefused(plan: CreatedPlan, approvalId: string, reason: string) {
    await expectCode(execute(plan, approvalId), 'FORBIDDEN');
    expect(await planStatus(plan.id)).toBe('APPROVED');
    const rows = await auditRows('approval.execute');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN', userId: requester });
    expect(rows[0]!.details).toMatchObject({ approvalId, planId: plan.id, reason });
  }

  it('refuses when the requester lost a capability permission after the approval', async () => {
    const { plan, approvalId } = await approved();
    const [operator] = await database.db.select().from(roles).where(eq(roles.key, 'OPERATOR'));
    await database.db
      .delete(userRoles)
      .where(and(eq(userRoles.userId, requester), eq(userRoles.roleId, operator!.id)));
    await expectRefused(plan, approvalId, 'requester_permission_missing');
  });

  it('refuses when a DENY rule was added after the approval', async () => {
    const { plan, approvalId } = await approved();
    await rule('DENY', requester, ['DATA.UPDATE']);
    await expectRefused(plan, approvalId, 'requester_policy_denied');
  });

  it('refuses when the requester was deactivated', async () => {
    const { plan, approvalId } = await approved();
    await database.db.update(users).set({ active: false }).where(eq(users.id, requester));
    await expectRefused(plan, approvalId, 'requester_inactive');
  });

  it('refuses when the current policy is stricter than the frozen gates', async () => {
    const { plan, approvalId } = await approved();
    await rule('ALLOW', requester, ['DATA.UPDATE'], ['TGFPAR'], { maxWriteRows: 1 });
    await expectRefused(plan, approvalId, 'requester_gates_stricter');
  });

  it('audits an execution attempt on a rejected approval', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    await service.decide(approval.id, decider, 'REJECT', null);
    await expectCode(execute(plan, approval.id), 'FORBIDDEN');
    const [row] = await auditRows('approval.execute');
    expect(row!.details).toMatchObject({ reason: 'approval_rejected' });
  });
});

describe('ApprovalsService.listPending', () => {
  it('lists the undecided approvals the user may decide', async () => {
    const plan = await plansService.create(newPlan());
    const approval = await service.request(plan.id, requester);
    const decidedPlan = await plansService.create(newPlan());
    const decided = await service.request(decidedPlan.id, requester);
    await service.decide(decided.id, decider2, 'REJECT', null);

    const list = await service.listPending(decider);
    expect(list.map((a) => a.id)).toEqual([approval.id]);
    expect(list[0]).toMatchObject({
      planId: plan.id,
      requestedBy: requester,
      plan: {
        environment: 'SANDBOX',
        connectionId: 'env-default',
        action: 'DATA.UPDATE',
        entities: ['TGFPAR'],
        targetCount: 2,
        sql: newPlan().sql,
        preview: { rows: 2 },
      },
    });
    // Not their own requests, nothing without a policy or without APPROVAL.DECIDE.
    expect(await service.listPending(requester)).toEqual([]);
    expect(await service.listPending(noPolicy)).toEqual([]);
    expect(await service.listPending(noPermission)).toEqual([]);
  });

  it('returns only the summary to a decider who may not read the entities', async () => {
    const plan = await plansService.create(newPlan());
    await service.request(plan.id, requester);
    await rule('DENY', decider, ['QUERY.SELECT']);
    const [item] = await service.listPending(decider);
    expect(item!.plan).toMatchObject({
      action: 'DATA.UPDATE',
      entities: ['TGFPAR'],
      targetCount: 2,
    });
    expect(item!.plan).not.toHaveProperty('sql');
    expect(item!.plan).not.toHaveProperty('preview');
    const [full] = await service.listPending(decider2);
    expect(full!.plan.sql).toBe(newPlan().sql);
  });
});

describe('ApprovalsService: scratch targets and audit failures', () => {
  it('refuses a scratch-route plan whose target is not a scratch table', async () => {
    const hybrid = await plansService.create(
      newPlan({
        sql: 'INSERT INTO TGFPAR (CODPARC) SELECT CODPARC FROM tmp_x',
        capability: {
          class: 'SCRATCH_ONLY',
          route: 'HYBRID',
          reason: 'mislabelled',
          action: 'TEMP.WRITE',
          actions: ['TEMP.WRITE', 'TEMP.MATERIALIZE', 'QUERY.SELECT'],
        },
      }),
    );
    await expectCode(service.request(hybrid.id, requester), 'VALIDATION_ERROR');
    const scratch = await plansService.create(
      newPlan({
        capability: {
          class: 'SCRATCH_ONLY',
          route: 'SCRATCH',
          reason: 'mislabelled',
          action: 'TEMP.WRITE',
          actions: ['TEMP.WRITE'],
        },
      }),
    );
    await expectCode(service.request(scratch.id, requester), 'VALIDATION_ERROR');
    expect(await database.db.select().from(approvals)).toHaveLength(0);
  });

  it('rethrows the original error and logs when the denied audit write fails', async () => {
    const logged: { obj: object; msg: string }[] = [];
    const failing = new ApprovalsService(database.db, {
      plans: plansService,
      policies: policyService,
      authz: new AuthzService(database.db),
      redact: () => {
        throw new Error('redactor down');
      },
      logger: { error: (obj, msg) => logged.push({ obj, msg }) },
    });
    await expectCode(failing.decide(randomUUID(), decider, 'APPROVE', null), 'NOT_FOUND');
    expect(logged).toHaveLength(1);
    expect(logged[0]!.obj).toMatchObject({ action: 'approval.decide', errorCode: 'NOT_FOUND' });
    expect(JSON.stringify(logged[0]!.obj)).not.toContain('redactor down');
  });
});
