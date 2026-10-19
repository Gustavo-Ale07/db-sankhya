import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  approvals,
  auditEvents,
  createDatabase,
  plans,
  policies,
  roles,
  userRoles,
  users,
} from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { DEFAULT_LIMITS, isAppError } from '@dbx/shared';
import type { ErrorCode, PolicyDecision } from '@dbx/shared';
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

async function addUser(email: string, roleKey?: string): Promise<string> {
  const [row] = await database.db
    .insert(users)
    .values({ email, name: email.split('@')[0]!, passwordHash: 'x' })
    .returning({ id: users.id });
  if (roleKey) {
    const [role] = await database.db.select().from(roles).where(eq(roles.key, roleKey));
    await database.db.insert(userRoles).values({ userId: row!.id, roleId: role!.id });
  }
  return row!.id;
}

async function allow(userId: string, entities = ['TGFPAR']): Promise<void> {
  await database.db.insert(policies).values({
    name: `allow ${userId}`,
    effect: 'ALLOW',
    subjectType: 'user',
    subjectId: userId,
    actions: ['DATA.UPDATE'],
    entities,
  });
  policyService.invalidate();
}

beforeEach(async () => {
  database = await createDatabase('pglite:memory');
  await database.migrate();
  // The requester holds APPROVAL.DECIDE and a policy too: only the four-eyes rule stops them.
  requester = await addUser('ana@example.com', 'ADMIN');
  decider = await addUser('bia@example.com', 'ADMIN');
  decider2 = await addUser('caio@example.com', 'ADMIN');
  noPolicy = await addUser('duda@example.com', 'ADMIN');
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
  limits: { ...DEFAULT_LIMITS, requireApproval },
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
      plan: { environment: 'SANDBOX', connectionId: 'env-default', sql: newPlan().sql },
    });
    // Not their own requests, nothing without a policy or without APPROVAL.DECIDE.
    expect(await service.listPending(requester)).toEqual([]);
    expect(await service.listPending(noPolicy)).toEqual([]);
    expect(await service.listPending(noPermission)).toEqual([]);
  });
});
