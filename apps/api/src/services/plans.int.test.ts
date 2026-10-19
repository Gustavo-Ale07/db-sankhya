import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, plans, users } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { DEFAULT_LIMITS, canonicalJSON, isAppError } from '@dbx/shared';
import type { ErrorCode, PolicyDecision } from '@dbx/shared';
import type { Capability } from '@dbx/sql-engine';
import { sha256Hex } from '../security/crypto';
import { PlansService, paramsHashOf, strongConfirmationPhrase } from './plans';
import type { NewPlan } from './plans';

const SECRET = 'plan-test-secret-fixture-0123456789abcdef';
const TTL = 300;

let database: DatabaseHandle;
let userId: string;
let otherUserId: string;
let sessionId: string;

beforeEach(async () => {
  database = await createDatabase('pglite:memory');
  await database.migrate();
  const inserted = await database.db
    .insert(users)
    .values([
      { email: 'ana@example.com', name: 'Ana', passwordHash: 'x' },
      { email: 'bia@example.com', name: 'Bia', passwordHash: 'x' },
    ])
    .returning({ id: users.id });
  userId = inserted[0]!.id;
  otherUserId = inserted[1]!.id;
  sessionId = randomUUID();
});

afterEach(async () => {
  await database.close();
});

const service = (now?: () => Date) =>
  new PlansService(database.db, { secret: SECRET, ttlSeconds: TTL, ...(now ? { now } : {}) });

const CAPABILITY: Capability = {
  class: 'SUPPORTED',
  route: 'SANKHYA_SAVE',
  reason: 'update through the gateway',
  action: 'DATA.UPDATE',
  actions: ['DATA.UPDATE'],
};

const decision = (over: Partial<PolicyDecision['limits']> = {}): PolicyDecision => ({
  effect: 'ALLOW',
  reasons: [],
  matchedRuleIds: ['r1'],
  limits: { ...DEFAULT_LIMITS, ...over },
  policyVersion: 'a'.repeat(64),
});

function newPlan(over: Partial<NewPlan> = {}): NewPlan {
  return {
    userId,
    sessionId,
    connectionId: 'env-default',
    environment: 'SANDBOX',
    sql: "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC IN (1, 2, 3)",
    params: [],
    capability: CAPABILITY,
    decision: decision(),
    targets: [
      { key: { CODPARC: 1 }, before: { NOMEPARC: 'A' } },
      { key: { CODPARC: 2 }, before: { NOMEPARC: 'B' } },
      { key: { CODPARC: 3 }, before: { NOMEPARC: 'C' } },
    ],
    preview: { rows: 3 },
    previewKind: 'UPDATE_DIFF',
    summary: { action: 'UPDATE', count: 3, entity: 'TGFPAR' },
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

const statusOf = async (id: string) =>
  (await database.db.select({ status: plans.status }).from(plans).where(eq(plans.id, id)))[0]
    ?.status;

/** Marks a plan APPROVED together with the four-eyes approval row `consume` requires. */
async function approveDirectly(planId: string): Promise<void> {
  await database.db.execute(
    sql`insert into approvals (plan_id, plan_hash, requested_by, decided_by, decision, decided_at, expires_at)
        select id, plan_hash, user_id, ${otherUserId}, 'APPROVE', now(), expires_at from plans where id = ${planId}`,
  );
  await database.db.update(plans).set({ status: 'APPROVED' }).where(eq(plans.id, planId));
}

describe('PlansService.create', () => {
  it('stores a PENDING plan and returns a session-bound token', async () => {
    const before = Date.now();
    const plan = await service().create(newPlan());
    expect(plan.token.startsWith(`${plan.id}.`)).toBe(true);
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TTL * 1000);
    expect(plan.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + TTL * 1000);

    const [row] = await database.db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row).toMatchObject({
      status: 'PENDING',
      userId,
      sessionId,
      connectionId: 'env-default',
      environment: 'SANDBOX',
      planHash: plan.planHash,
      sqlHash: sha256Hex(newPlan().sql),
      targetsHash: sha256Hex(canonicalJSON(newPlan().targets)),
      paramsHash: sha256Hex(canonicalJSON([])),
      policyVersion: 'a'.repeat(64),
      requiresApproval: false,
      strongConfirmationPhrase: null,
      previewKind: 'UPDATE_DIFF',
      consumedAt: null,
    });
    expect(row!.capability).toEqual(CAPABILITY);
  });

  it('computes planHash from the brief fields plus the gate fields with canonical JSON', async () => {
    const input = newPlan({ environment: 'PRODUCTION' });
    const plan = await service().create(input);
    const expected = sha256Hex(
      canonicalJSON({
        sqlHash: sha256Hex(input.sql),
        paramsHash: sha256Hex(canonicalJSON(input.params)),
        userId,
        connectionId: input.connectionId,
        environment: input.environment,
        policyVersion: input.decision.policyVersion,
        targetsHash: sha256Hex(canonicalJSON(input.targets)),
        capability: input.capability,
        requiresApproval: false,
        strongConfirmationPhrase: 'PRODUCTION UPDATE 3 TGFPAR',
        expiresAt: plan.expiresAt.toISOString(),
        decisionHash: sha256Hex(canonicalJSON(input.decision)),
        previewHash: sha256Hex(canonicalJSON(input.preview)),
        previewKind: input.previewKind,
      }),
    );
    expect(plan.planHash).toBe(expected);
  });

  it('sets the strong phrase in PRODUCTION and when the decision asks for it', async () => {
    const prod = await service().create(newPlan({ environment: 'PRODUCTION' }));
    const strong = await service().create(
      newPlan({ decision: decision({ requireStrongConfirmation: true }) }),
    );
    const rows = await database.db.select().from(plans);
    const phrase = (id: string) => rows.find((r) => r.id === id)?.strongConfirmationPhrase;
    expect(phrase(prod.id)).toBe('PRODUCTION UPDATE 3 TGFPAR');
    expect(phrase(strong.id)).toBe('SANDBOX UPDATE 3 TGFPAR');
    expect(strongConfirmationPhrase('PRODUCTION', 'update', 3, 'tgfpar')).toBe(
      'PRODUCTION UPDATE 3 TGFPAR',
    );
  });

  it('copies requireApproval from the decision', async () => {
    const plan = await service().create(newPlan({ decision: decision({ requireApproval: true }) }));
    const [row] = await database.db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row!.requiresApproval).toBe(true);
  });

  it('refuses a denied decision or an unsupported capability', async () => {
    await expectCode(
      service().create(newPlan({ decision: { ...decision(), effect: 'DENY' } })),
      'FORBIDDEN',
    );
    await expectCode(
      service().create(
        newPlan({ capability: { ...CAPABILITY, class: 'UNSUPPORTED', route: 'NONE' } }),
      ),
      'FORBIDDEN',
    );
    await expectCode(
      service().create(
        newPlan({
          capability: { ...CAPABILITY, blocked: { code: 'MISSING_WHERE', reason: 'no where' } },
        }),
      ),
      'FORBIDDEN',
    );
  });

  it('refuses malformed input', async () => {
    await expectCode(service().create(newPlan({ sessionId: 'nope' })), 'VALIDATION_ERROR');
    await expectCode(
      service().create(newPlan({ environment: 'STAGING' as never })),
      'VALIDATION_ERROR',
    );
    await expectCode(
      service().create(newPlan({ summary: { action: 'UPDATE', count: -1, entity: 'TGFPAR' } })),
      'VALIDATION_ERROR',
    );
    await expectCode(
      service().create(
        newPlan({ summary: { action: 'UPDATE', count: 3, entity: 'TGFPAR; DROP' } }),
      ),
      'VALIDATION_ERROR',
    );
  });

  it('refuses a phrase count that differs from the number of targets', async () => {
    await expectCode(
      service().create(newPlan({ summary: { action: 'UPDATE', count: 2, entity: 'TGFPAR' } })),
      'VALIDATION_ERROR',
    );
    // A non-array target snapshot is not counted.
    const plan = await service().create(
      newPlan({ targets: { rows: [] }, summary: { action: 'UPDATE', count: 7, entity: 'TGFPAR' } }),
    );
    expect(plan.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses NUL characters in targets, preview or params with VALIDATION_ERROR', async () => {
    const nul = 'a\u0000b';
    for (const over of [
      { targets: [{ key: { CODPARC: 1 }, before: { NOMEPARC: nul } }, {}, {}] },
      { targets: [{ key: { [nul]: 1 } }, {}, {}] },
      { preview: { rows: [nul] } },
      { params: [1, { deep: [nul] }] },
    ] satisfies Partial<NewPlan>[]) {
      await expectCode(service().create(newPlan(over)), 'VALIDATION_ERROR');
    }
    expect(await database.db.select().from(plans)).toHaveLength(0);
  });

  it('exports paramsHashOf, the hash stored as params_hash', async () => {
    const params = [1, 'x', { b: 2, a: [null, true] }];
    const plan = await service().create(newPlan({ params }));
    const [row] = await database.db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row!.paramsHash).toBe(paramsHashOf(params));
    expect(paramsHashOf([1, 'x', { a: [null, true], b: 2 }])).toBe(paramsHashOf(params));
    expect(paramsHashOf([2])).not.toBe(paramsHashOf(params));
  });
});

describe('PlansService.consume', () => {
  it('consumes a PENDING plan once', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const result = await svc.consume({ id: plan.id, token: plan.token, userId, sessionId });
    expect(result.replayed).toBe(false);
    const row = result.plan;
    expect(row.status).toBe('CONSUMED');
    expect(row.consumedAt).toBeInstanceOf(Date);
    expect(row.id).toBe(plan.id);
  });

  it('refuses a non-string token or idempotency key', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const base = { id: plan.id, token: plan.token, userId, sessionId };
    for (const attempt of [
      { ...base, token: 42 },
      { ...base, token: null },
      { ...base, token: { toString: () => plan.token } },
      { ...base, idempotencyKey: 7 },
      { ...base, idempotencyKey: null },
      { ...base, idempotencyKey: ['k-1'] },
    ]) {
      await expectCode(svc.consume(attempt as never), 'CONFIRMATION_INVALID');
    }
    expect(await statusOf(plan.id)).toBe('PENDING');
  });

  it('binds the token to the session', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId: randomUUID() }),
      'CONFIRMATION_INVALID',
    );
    expect(await statusOf(plan.id)).toBe('PENDING');
  });

  it('refuses another user, a forged token or a token for another plan', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const other = await svc.create(newPlan());
    const [, mac] = plan.token.split('.');
    for (const attempt of [
      { id: plan.id, token: plan.token, userId: otherUserId, sessionId },
      { id: plan.id, token: `${plan.id}.${'A'.repeat(mac!.length)}`, userId, sessionId },
      { id: plan.id, token: `${plan.id}.short`, userId, sessionId },
      { id: plan.id, token: other.token, userId, sessionId },
      { id: plan.id, token: 'garbage', userId, sessionId },
      { id: 'not-a-uuid', token: 'not-a-uuid.x', userId, sessionId },
      { id: randomUUID(), token: plan.token, userId, sessionId },
    ]) {
      await expectCode(svc.consume(attempt), 'CONFIRMATION_INVALID');
    }
    expect(await statusOf(plan.id)).toBe('PENDING');
  });

  it('expires after PLAN_TTL_SECONDS', async () => {
    const past = (seconds: number) => () => new Date(Date.now() - seconds * 1000);
    const expired = await service(past(TTL + 1)).create(newPlan());
    await expectCode(
      service().consume({ id: expired.id, token: expired.token, userId, sessionId }),
      'CONFIRMATION_EXPIRED',
    );
    expect(await statusOf(expired.id)).toBe('EXPIRED');
    // Still expired on a retry, never consumable again.
    await expectCode(
      service().consume({ id: expired.id, token: expired.token, userId, sessionId }),
      'CONFIRMATION_EXPIRED',
    );

    const fresh = await service(past(TTL - 30)).create(newPlan());
    const { plan: row } = await service().consume({
      id: fresh.id,
      token: fresh.token,
      userId,
      sessionId,
    });
    expect(row.status).toBe('CONSUMED');
  });

  it('refuses a second consume', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    await svc.consume({ id: plan.id, token: plan.token, userId, sessionId });
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      'CONFIRMATION_USED',
    );
  });

  it('lets exactly one of two concurrent consumes win', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const results = await Promise.allSettled([
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isAppError(rejected.reason) && rejected.reason.code).toBe('CONFIRMATION_USED');
  });

  it('invalidates the plans of a rotated connection', async () => {
    const svc = service();
    const a = await svc.create(newPlan({ connectionId: 'c-1' }));
    const b = await svc.create(newPlan({ connectionId: 'c-1' }));
    const keep = await svc.create(newPlan({ connectionId: 'c-2' }));
    const used = await svc.create(newPlan({ connectionId: 'c-1' }));
    await svc.consume({ id: used.id, token: used.token, userId, sessionId });
    await database.db.update(plans).set({ status: 'APPROVED' }).where(eq(plans.id, b.id));

    expect(await svc.invalidateForConnection('c-1')).toBe(2);
    expect(await statusOf(a.id)).toBe('INVALIDATED');
    expect(await statusOf(b.id)).toBe('INVALIDATED');
    expect(await statusOf(used.id)).toBe('CONSUMED');
    expect(await statusOf(keep.id)).toBe('PENDING');
    await expectCode(
      svc.consume({ id: a.id, token: a.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );
    await expectCode(
      svc.consume({ id: b.id, token: b.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );
  });

  it('refuses a plan whose stored content no longer matches its hash', async () => {
    const svc = service();
    for (const change of [
      sql`environment = 'PRODUCTION'`,
      sql`connection_id = 'c-other'`,
      sql`sql = 'UPDATE TGFPAR SET NOMEPARC = ''Y'''`,
      sql`targets = '[]'::jsonb`,
      sql`capability = jsonb_set(capability, '{route}', '"SCRATCH"')`,
    ]) {
      const plan = await svc.create(newPlan());
      await database.db.execute(sql`update plans set ${change} where id = ${plan.id}`);
      await expectCode(
        svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
        'CONFIRMATION_INVALID',
      );
      expect(await statusOf(plan.id)).toBe('PENDING');
    }
  });

  it('refuses a plan whose gate columns were altered', async () => {
    const svc = service();
    const gated = () =>
      newPlan({ environment: 'PRODUCTION', decision: decision({ requireApproval: true }) });
    const cases: Array<[string, () => NewPlan, ReturnType<typeof sql>]> = [
      ['clear requires_approval', gated, sql`requires_approval = false`],
      ['set requires_approval', newPlan, sql`requires_approval = true`],
      ['change the phrase', gated, sql`strong_confirmation_phrase = 'PRODUCTION UPDATE 1 X'`],
      ['clear the phrase', gated, sql`strong_confirmation_phrase = null`],
      ['add a phrase', newPlan, sql`strong_confirmation_phrase = 'SANDBOX UPDATE 3 TGFPAR'`],
      ['extend expires_at', newPlan, sql`expires_at = expires_at + interval '1 hour'`],
      [
        'rewrite the decision',
        newPlan,
        sql`decision = jsonb_set(decision, '{matchedRuleIds}', '["r9"]')`,
      ],
      [
        'clear approval in decision and column',
        gated,
        sql`decision = jsonb_set(decision, '{limits,requireApproval}', 'false'), requires_approval = false`,
      ],
      ['change policy_version', newPlan, sql`policy_version = ${'b'.repeat(64)}`],
      ['change the preview', newPlan, sql`preview = '{"rows":1}'::jsonb`],
      ['change preview_kind', newPlan, sql`preview_kind = 'OTHER'`],
    ];
    for (const [name, make, change] of cases) {
      const plan = await svc.create(make());
      await database.db.execute(sql`update plans set ${change} where id = ${plan.id}`);
      // Approve where needed so only the tampering can be the reason for the refusal.
      const [stored] = await database.db.select().from(plans).where(eq(plans.id, plan.id));
      if (stored!.requiresApproval) await approveDirectly(plan.id);
      const err = await svc
        .consume({
          id: plan.id,
          token: plan.token,
          userId,
          sessionId,
          strongConfirmation: 'PRODUCTION UPDATE 3 TGFPAR',
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(isAppError(err) ? err.code : err, name).toBe('CONFIRMATION_INVALID');
    }

    // Control: the same gated plan, untouched and approved, is consumable.
    const control = await svc.create(gated());
    await approveDirectly(control.id);
    const { plan: row } = await svc.consume({
      id: control.id,
      token: control.token,
      userId,
      sessionId,
      strongConfirmation: 'PRODUCTION UPDATE 3 TGFPAR',
    });
    expect(row.status).toBe('CONSUMED');
  });

  it('requires the exact strong phrase', async () => {
    const svc = service();
    const plan = await svc.create(newPlan({ environment: 'PRODUCTION' }));
    for (const strongConfirmation of [
      undefined,
      '',
      'PRODUCTION UPDATE 2 TGFPAR',
      'production update 3 tgfpar',
    ]) {
      await expectCode(
        svc.consume({
          id: plan.id,
          token: plan.token,
          userId,
          sessionId,
          ...(strongConfirmation === undefined ? {} : { strongConfirmation }),
        }),
        'CONFIRMATION_INVALID',
      );
    }
    expect(await statusOf(plan.id)).toBe('PENDING');
    const { plan: row } = await svc.consume({
      id: plan.id,
      token: plan.token,
      userId,
      sessionId,
      strongConfirmation: 'PRODUCTION UPDATE 3 TGFPAR',
    });
    expect(row.status).toBe('CONSUMED');
  });

  it('returns the original consumed plan on a retry with the same idempotency key', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const input = { id: plan.id, token: plan.token, userId, sessionId, idempotencyKey: 'k-1' };
    const first = await svc.consume(input);
    const retry = await svc.consume(input);
    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.plan).toEqual(first.plan);
    expect(retry.plan.idempotencyKey).toBe('k-1');

    await expectCode(svc.consume({ ...input, idempotencyKey: 'k-2' }), 'CONFIRMATION_USED');
    const { idempotencyKey: _ignored, ...withoutKey } = input;
    await expectCode(svc.consume(withoutKey), 'CONFIRMATION_USED');
    // The retry is still bound to the session.
    await expectCode(svc.consume({ ...input, sessionId: randomUUID() }), 'CONFIRMATION_INVALID');
  });

  it('refuses an idempotency key already used for another plan', async () => {
    const svc = service();
    const a = await svc.create(newPlan());
    const b = await svc.create(newPlan());
    await svc.consume({ id: a.id, token: a.token, userId, sessionId, idempotencyKey: 'k-1' });
    await expectCode(
      svc.consume({ id: b.id, token: b.token, userId, sessionId, idempotencyKey: 'k-1' }),
      'CONFIRMATION_INVALID',
    );
    expect(await statusOf(b.id)).toBe('PENDING');
  });

  it('performs the transition exactly once for parallel consumes with the same key', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    const input = { id: plan.id, token: plan.token, userId, sessionId, idempotencyKey: 'k-par' };
    const results = await Promise.allSettled([
      svc.consume(input),
      svc.consume(input),
      svc.consume(input),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(3);
    expect(fulfilled.filter((r) => !r.value.replayed)).toHaveLength(1);
    expect(fulfilled.filter((r) => r.value.replayed)).toHaveLength(2);
    for (const r of fulfilled) expect(r.value.plan.id).toBe(plan.id);
  });

  it('lets one of two plans win a parallel race for the same key', async () => {
    const svc = service();
    const a = await svc.create(newPlan());
    const b = await svc.create(newPlan());
    const results = await Promise.allSettled([
      svc.consume({ id: a.id, token: a.token, userId, sessionId, idempotencyKey: 'k-race' }),
      svc.consume({ id: b.id, token: b.token, userId, sessionId, idempotencyKey: 'k-race' }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(ok[0]!.value.replayed).toBe(false);
    expect(failed).toHaveLength(1);
    const reason: unknown = failed[0]!.reason;
    expect(isAppError(reason) ? reason.code : reason).toBe('CONFIRMATION_INVALID');
    const statuses = [await statusOf(a.id), await statusOf(b.id)].sort();
    expect(statuses).toEqual(['CONSUMED', 'PENDING']);
  });

  it('refuses a malformed idempotency key', async () => {
    const svc = service();
    const plan = await svc.create(newPlan());
    await expectCode(
      svc.consume({
        id: plan.id,
        token: plan.token,
        userId,
        sessionId,
        idempotencyKey: 'x'.repeat(201),
      }),
      'CONFIRMATION_INVALID',
    );
  });

  it('cannot consume a plan requiring approval while PENDING', async () => {
    const svc = service();
    const plan = await svc.create(newPlan({ decision: decision({ requireApproval: true }) }));
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );
    expect(await statusOf(plan.id)).toBe('PENDING');

    // APPROVED without a four-eyes approval row (e.g. a direct status write) is not consumable.
    await database.db.update(plans).set({ status: 'APPROVED' }).where(eq(plans.id, plan.id));
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );
    // Nor is an APPROVE approval recorded for another plan hash.
    await database.db.execute(
      sql`insert into approvals (plan_id, plan_hash, requested_by, expires_at) values (${plan.id}, ${plan.planHash}, ${userId}, ${plan.expiresAt.toISOString()})`,
    );
    await database.db.execute(
      sql`update approvals set plan_hash = ${'f'.repeat(64)}, decision = 'APPROVE', decided_by = ${otherUserId}, decided_at = now() where plan_id = ${plan.id}`,
    );
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );

    await database.db.execute(
      sql`update approvals set plan_hash = ${plan.planHash} where plan_id = ${plan.id}`,
    );
    const { plan: row } = await svc.consume({ id: plan.id, token: plan.token, userId, sessionId });
    expect(row.status).toBe('CONSUMED');
  });

  it('approves a plan only when an APPROVE approval row exists (decide)', async () => {
    const svc = service();
    const plan = await svc.create(newPlan({ decision: decision({ requireApproval: true }) }));
    expect(await svc.decide(plan.id, plan.planHash, 'APPROVE')).toBe(false);
    expect(await statusOf(plan.id)).toBe('PENDING');
    await expectCode(
      svc.consume({ id: plan.id, token: plan.token, userId, sessionId }),
      'CONFIRMATION_INVALID',
    );
    // A rejection needs no approval row: it only makes the plan unusable.
    expect(await svc.decide(plan.id, plan.planHash, 'REJECT')).toBe(true);
    expect(await statusOf(plan.id)).toBe('INVALIDATED');
  });
});
