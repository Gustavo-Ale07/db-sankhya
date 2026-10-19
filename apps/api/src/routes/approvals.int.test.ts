import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { auditEvents, createDatabase, plans, users } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { DEFAULT_LIMITS } from '@dbx/shared';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import type { AppConfig } from '../config';
import { PlansService } from '../services/plans';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'User!Strong#Pass9';

let app: FastifyInstance;
let database: DatabaseHandle;
let config: AppConfig;

beforeEach(async () => {
  config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: ORIGIN,
    DATABASE_URL: 'pglite:memory',
    SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
    BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
    LOG_LEVEL: 'silent',
    SANKHYA_MODE: 'mock',
    APPROVAL_TTL_MINUTES: '45',
  });
  database = await createDatabase(config.databaseUrl);
  await database.migrate();
  app = await buildApp({ config, database, logger: false });
});

afterEach(async () => {
  await app.close();
  await database.close();
});

const call = (cookie: string | null, opts: InjectOptions) =>
  app.inject({
    ...opts,
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie: `${config.session.cookieName}=${cookie}` } : {}),
    },
  });

async function userWith(email: string, roles: string[]): Promise<{ id: string; cookie: string }> {
  await app.services.users.create({ email, name: email, password: PASSWORD, roles });
  const res = await call(null, {
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode, res.body).toBe(200);
  const cookie = res.cookies.find((c) => c.name === config.session.cookieName)!.value;
  const [row] = await database.db.select().from(users).where(eq(users.email, email));
  return { id: row!.id, cookie };
}

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

describe('approval routes', () => {
  it('requests, lists and decides an approval, auditing the decision', async () => {
    const requester = await userWith('ana@example.com', ['OPERATOR']);
    // ADMIN alone holds no DATA.*: approving an ERP write also needs DATA.UPDATE.
    const decider = await userWith('bia@example.com', ['ADMIN', 'OPERATOR']);
    await app.services.policies.create({
      name: 'bia approves TGFPAR updates',
      effect: 'ALLOW',
      subjectType: 'user',
      subjectId: decider.id,
      environments: [],
      connectionIds: [],
      actions: ['DATA.UPDATE'],
      entities: ['TGFPAR'],
      columns: [],
      limits: {},
      overrideWhereRequired: false,
      enabled: true,
    });
    const plansService = new PlansService(database.db, {
      secret: config.session.secret,
      ttlSeconds: config.planTtlSeconds,
      approvalTtlSeconds: config.approvalTtlMinutes * 60,
    });
    const plan = await plansService.create({
      userId: requester.id,
      sessionId: randomUUID(),
      connectionId: 'env-default',
      environment: 'SANDBOX',
      sql: "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1",
      params: [],
      capability: {
        class: 'SUPPORTED',
        route: 'SANKHYA_SAVE',
        reason: 'update',
        action: 'DATA.UPDATE',
        actions: ['DATA.UPDATE'],
      },
      decision: {
        effect: 'ALLOW',
        reasons: [],
        matchedRuleIds: [],
        limits: { ...DEFAULT_LIMITS, requireApproval: true },
        policyVersion: 'b'.repeat(64),
      },
      targets: [{ key: { CODPARC: 1 } }],
      preview: {},
      previewKind: 'UPDATE_DIFF',
      summary: { action: 'UPDATE', count: 1, entity: 'TGFPAR' },
    });
    expect(config.approvalTtlMinutes).toBe(45);

    const anonymous = await call(null, { method: 'GET', url: '/api/approvals/pending' });
    expect(anonymous.statusCode).toBe(401);

    const requested = await call(requester.cookie, {
      method: 'POST',
      url: '/api/approvals',
      payload: { planId: plan.id },
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const approval = (requested.json() as { approval: { id: string; planHash: string } }).approval;
    expect(approval.planHash).toBe(plan.planHash);

    expect(
      codeOf(await call(requester.cookie, { method: 'GET', url: '/api/approvals/pending' })),
    ).toBe('FORBIDDEN');
    const pending = await call(decider.cookie, { method: 'GET', url: '/api/approvals/pending' });
    expect(pending.statusCode).toBe(200);
    expect((pending.json() as { items: { id: string }[] }).items.map((a) => a.id)).toEqual([
      approval.id,
    ]);

    const self = await call(requester.cookie, {
      method: 'POST',
      url: `/api/approvals/${approval.id}/decision`,
      payload: { decision: 'APPROVE' },
    });
    expect(codeOf(self)).toBe('FORBIDDEN');
    const bad = await call(decider.cookie, {
      method: 'POST',
      url: `/api/approvals/${approval.id}/decision`,
      payload: { decision: 'APPROVE', extra: 1 },
    });
    expect(codeOf(bad)).toBe('VALIDATION_ERROR');

    const decided = await call(decider.cookie, {
      method: 'POST',
      url: `/api/approvals/${approval.id}/decision`,
      payload: { decision: 'APPROVE', reason: 'ok' },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({
      approval: { id: approval.id, decision: 'APPROVE', decidedBy: decider.id, reason: 'ok' },
    });
    const [row] = await database.db.select().from(plans).where(eq(plans.id, plan.id));
    expect(row!.status).toBe('APPROVED');

    const audit = await database.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'approval.decide'));
    expect(audit.map((a) => a.status).sort()).toEqual(['success']);
    expect(audit[0]).toMatchObject({ userId: decider.id, userEmail: 'bia@example.com' });
    expect(audit[0]!.requestId).toBeTruthy();
  });
});
