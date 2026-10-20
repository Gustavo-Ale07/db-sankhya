import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { eq } from 'drizzle-orm';
import { createDatabase, plans, rolePermissions, roles } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import type { PolicyInput } from '../services/policy';
import { ROLLBACK_LABEL } from '../services/rollback';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';

const ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  LOG_LEVEL: 'silent',
  SANKHYA_MODE: 'mock',
  SANKHYA_BASE_URL: 'https://gateway.example.com',
  SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  SANKHYA_CLIENT_ID: MOCK_CREDENTIALS.clientId,
  SANKHYA_CLIENT_SECRET: MOCK_CREDENTIALS.clientSecret,
  SANKHYA_X_TOKEN: MOCK_CREDENTIALS.xToken,
  SANKHYA_DIALECT: 'oracle',
  SANKHYA_ENVIRONMENT: 'HOMOLOGATION',
  // Every write switch on, so plans can execute.
  SAFE_MODE: 'false',
  GLOBAL_WRITE_ENABLED: 'true',
  WRITE_TO_SANKHYA: 'true',
};

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  mock: MockSankhya;
  userWith(permissions: Permission[]): Promise<string>;
  call(cookie: string | null, opts: InjectOptions): Promise<Response>;
  policy(input: Partial<PolicyInput>): Promise<void>;
}

const open: Array<{ app: FastifyInstance; database: DatabaseHandle; mock: MockSankhya }> = [];
afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
    await h.mock.close();
  }
});

async function setup(): Promise<Harness> {
  const config = loadConfig(ENV);
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const mock = await createMockSankhya();
  const app = await buildApp({
    config,
    database,
    logger: false,
    sankhya: { mockGateway: () => Promise.resolve({ ...mock, close: async () => undefined }) },
  });
  open.push({ app, database, mock });
  await app.services.users.create({
    email: ADMIN.email,
    name: 'Admin',
    password: ADMIN.password,
    roles: config.bootstrapAdmin.roles,
  });
  const call: Harness['call'] = (cookie, opts) =>
    app.inject({
      ...opts,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie: `${config.session.cookieName}=${cookie}` } : {}),
        ...(opts.headers ?? {}),
      },
    });
  let n = 0;
  const userWith = async (permissions: Permission[]) => {
    const key = `CUSTOM_${++n}`;
    const [role] = await database.db
      .insert(roles)
      .values({ key, name: key })
      .returning({ id: roles.id });
    await database.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
    const email = `user${n}@example.com`;
    await app.services.users.create({ email, name: 'User', password: PASSWORD, roles: [key] });
    const login = await call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    return login.cookies.find((x) => x.name === config.session.cookieName)!.value;
  };
  const policy = async (input: Partial<PolicyInput>) => {
    await app.services.policies.create({
      name: 'test rule',
      effect: 'DENY',
      subjectType: 'everyone',
      subjectId: null,
      environments: [],
      connectionIds: [],
      actions: ['DATA.UPDATE'],
      entities: [],
      columns: [],
      limits: {},
      overrideWhereRequired: false,
      enabled: true,
      ...input,
    });
  };
  // Writes are default-deny: grant DATA.* everywhere for the bench.
  await policy({ name: 'writes allowed', effect: 'ALLOW', actions: ['DATA.*'] });
  return { app, database, mock, userWith, call, policy };
}

const WRITER: Permission[] = ['QUERY.SELECT', 'DATA.UPDATE', 'AUDIT.READ'];

const partner = async (mock: MockSankhya, id: number) =>
  (
    await mock.db.query<{ nomeparc: string }>('SELECT nomeparc FROM tgfpar WHERE codparc = $1', [
      id,
    ])
  ).rows[0]?.nomeparc;

const saves = (mock: MockSankhya) => mock.calls.filter((c) => c.serviceName === 'DatasetSP.save');

/** Previews and executes `sql`; returns the execute response. */
async function run(h: Harness, cookie: string, sql: string): Promise<Response> {
  const planned = await h.call(cookie, {
    method: 'POST',
    url: '/api/query/preview',
    payload: { sql },
  });
  expect(planned.statusCode, planned.body).toBe(200);
  const { planId, token } = planned.json() as { planId: string; token: string };
  return executePlan(h, cookie, planId, token);
}

const executePlan = (h: Harness, cookie: string, planId: string, token: string) =>
  h.call(cookie, {
    method: 'POST',
    url: '/api/query/execute',
    payload: { planId, token, idempotencyKey: randomUUID() },
  });

/** The PLAN_EXECUTED audit event of the last execution. */
async function lastExecuted(h: Harness, cookie: string): Promise<{ id: string }> {
  const res = await h.call(cookie, { method: 'GET', url: '/api/audit?action=PLAN_EXECUTED' });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { items: Array<{ id: string }> }).items[0]!;
}

const rollbackPlan = (h: Harness, cookie: string | null, id: string) =>
  h.call(cookie, { method: 'POST', url: `/api/audit/${id}/rollback-plan` });

describe('POST /api/audit/:id/rollback-plan', () => {
  it('a verified UPDATE: the plan goes through prepare and, executed, restores the before values', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    const original = (await partner(h.mock, 1))!;
    const done = await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 1");
    expect(done.json()).toMatchObject({ verification: 'VERIFIED' });
    expect(await partner(h.mock, 1)).toBe('Novo nome');
    const event = await lastExecuted(h, cookie);
    const savesBefore = saves(h.mock).length;

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      type: 'rollback-plan',
      label: ROLLBACK_LABEL,
      sourceEventId: event.id,
      statements: 1,
      conflict: { detected: false, columns: [] },
      plan: {
        previewKind: 'IMPACT_ANALYSIS',
        preview: {
          affected: 1,
          targets: [
            {
              key: { CODPARC: 1 },
              before: { NOMEPARC: 'Novo nome' },
              after: { NOMEPARC: original },
            },
          ],
        },
      },
    });
    expect(body.sql).toMatch(/^UPDATE TGFPAR SET NOMEPARC = '.*' WHERE \(CODPARC = 1\)$/);
    expect(body.displaySql).toBe(body.sql);
    // The plan is new: it was prepared (audited), nothing was written.
    expect(saves(h.mock)).toHaveLength(savesBefore);
    expect(await partner(h.mock, 1)).toBe('Novo nome');
    const created = await h.call(cookie, {
      method: 'GET',
      url: `/api/audit?action=PLAN_CREATED&planId=${body.plan.planId}`,
    });
    expect(created.json().items).toHaveLength(1);
    const linked = await h.call(cookie, {
      method: 'GET',
      url: '/api/audit?action=rollback.planned',
    });
    expect(linked.json().items[0]).toMatchObject({
      planId: body.plan.planId,
      details: { sourceEventId: event.id, conflict: false },
    });

    // Executing the plan restores the before value.
    const back = await executePlan(h, cookie, body.plan.planId, body.plan.token);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json()).toMatchObject({ status: 'success', verification: 'VERIFIED' });
    expect(await partner(h.mock, 1)).toBe(original);
  });

  it('a row changed after the original write: the preview shows a conflict; changed again, execute gives TARGETS_CHANGED', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 2");
    const event = await lastExecuted(h, cookie);
    await h.mock.db.query("UPDATE tgfpar SET nomeparc = 'Mudou depois' WHERE codparc = 2");

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.label).toBe(ROLLBACK_LABEL);
    expect(body.conflict).toMatchObject({
      detected: true,
      columns: [{ column: 'NOMEPARC', expected: 'Novo nome', current: 'Mudou depois' }],
    });
    expect(body.conflict.message).toMatch(/changed after/i);
    expect(body.plan.preview.targets[0].before).toMatchObject({ NOMEPARC: 'Mudou depois' });

    const savesBefore = saves(h.mock).length;
    await h.mock.db.query("UPDATE tgfpar SET nomeparc = 'Mudou de novo' WHERE codparc = 2");
    const exec = await executePlan(h, cookie, body.plan.planId, body.plan.token);
    expect(exec.statusCode).toBe(409);
    expect(exec.json().error.code).toBe('TARGETS_CHANGED');
    expect(saves(h.mock)).toHaveLength(savesBefore);
    expect(await partner(h.mock, 2)).toBe('Mudou de novo');
  });

  it('no snapshot (auditSnapshots=false): 409 with an explanation, nothing prepared', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    await h.policy({
      name: 'no snapshots',
      effect: 'ALLOW',
      actions: ['DATA.UPDATE'],
      entities: ['TGFPAR'],
      limits: { auditSnapshots: false },
    });
    await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Sem foto' WHERE CODPARC = 3");
    const event = await lastExecuted(h, cookie);
    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CONFLICT');
    expect(res.json().error.message).toMatch(/snapshot/i);
    const created = await h.call(cookie, { method: 'GET', url: '/api/audit?action=PLAN_CREATED' });
    // Only the original preview created a plan.
    expect(created.json().items).toHaveLength(1);
  });

  it('a non-UPDATE event or an unverified one: 409; an unknown id: 404', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Outro' WHERE CODPARC = 4");
    const list = await h.call(cookie, { method: 'GET', url: '/api/audit?action=PLAN_CREATED' });
    const created = (list.json() as { items: Array<{ id: string }> }).items[0]!;
    const res = await rollbackPlan(h, cookie, created.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/executed plan/i);

    const missing = await rollbackPlan(h, cookie, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect((await rollbackPlan(h, cookie, 'not-a-uuid')).statusCode).toBe(400);
  });

  it('needs AUDIT.READ; the prepare runs under the caller own write permission and policy', async () => {
    const h = await setup();
    const writer = await h.userWith(WRITER);
    await run(h, writer, "UPDATE TGFPAR SET NOMEPARC = 'Mais um' WHERE CODPARC = 5");
    const event = await lastExecuted(h, writer);

    expect((await rollbackPlan(h, null, event.id)).statusCode).toBe(401);
    const csrf = await h.call(writer, {
      method: 'POST',
      url: `/api/audit/${event.id}/rollback-plan`,
      headers: { origin: 'https://evil.example.com' },
    });
    expect(csrf.statusCode).toBe(403);

    const noAudit = await h.userWith(['QUERY.SELECT', 'DATA.UPDATE']);
    const r1 = await rollbackPlan(h, noAudit, event.id);
    expect(r1.statusCode).toBe(403);

    // An auditor without DATA.UPDATE reads the event but cannot plan the write.
    const auditor = await h.userWith(['QUERY.SELECT', 'AUDIT.READ']);
    const r2 = await rollbackPlan(h, auditor, event.id);
    expect(r2.statusCode).toBe(403);
    expect(r2.json().error.code).toBe('FORBIDDEN');

    // A policy DENY on the entity refuses the rollback like any other write.
    await h.policy({ name: 'deny partners', actions: ['DATA.UPDATE'], entities: ['TGFPAR'] });
    const r3 = await rollbackPlan(h, writer, event.id);
    expect(r3.statusCode).toBe(403);
    expect(r3.json().error.code).toBe('FORBIDDEN');
  });
});

const BS = String.fromCharCode(92);

const column = async (mock: MockSankhya, col: string, id: number) =>
  (
    await mock.db.query<Record<string, unknown>>(
      `SELECT ${col} AS v FROM tgfpar WHERE codparc = $1`,
      [id],
    )
  ).rows[0]?.v;

const eventsOf = async (h: Harness, cookie: string, action: string) =>
  (await h.call(cookie, { method: 'GET', url: `/api/audit?action=${action}` })).json() as {
    total: number;
    items: Array<{ id: string; connectionId: string; snapshot: unknown }>;
  };

describe('rollback-plan: exact values, scope and failures', () => {
  it('backslashes and quotes are restored byte for byte and VERIFIED', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    const original = `C:${BS}temp${BS}new ${BS}${BS}share ${BS}n O'Neil ${BS}`;
    await h.mock.db.query('UPDATE tgfpar SET nomeparc = $1 WHERE codparc = 1', [original]);
    const done = await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Novo' WHERE CODPARC = 1");
    expect(done.json().verification).toBe('VERIFIED');
    const event = await lastExecuted(h, cookie);

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const back = await executePlan(h, cookie, body.plan.planId, body.plan.token);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().verification).toBe('VERIFIED');
    expect(await partner(h.mock, 1)).toBe(original);
  });

  it('a multi-row UPDATE: one statement per target, only the first prepared', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    const one = await partner(h.mock, 1);
    const two = await partner(h.mock, 2);
    const done = await run(
      h,
      cookie,
      "UPDATE TGFPAR SET NOMEPARC = 'Mesmo' WHERE CODPARC IN (1, 2)",
    );
    expect(done.json().verification).toBe('VERIFIED');
    const event = await lastExecuted(h, cookie);

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.statements).toBe(2);
    const lines = (body.displaySql as string).split(';\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(body.sql);
    expect(lines.join('\n')).toMatch(/WHERE \(CODPARC = 1\)/);
    expect(lines.join('\n')).toMatch(/WHERE \(CODPARC = 2\)/);
    expect(body.plan.preview.targets).toHaveLength(1);

    const back = await executePlan(h, cookie, body.plan.planId, body.plan.token);
    expect(back.json().verification).toBe('VERIFIED');
    const restored = lines[0]!.includes('CODPARC = 1') ? 1 : 2;
    expect(await partner(h.mock, restored)).toBe(restored === 1 ? one : two);
    expect(await partner(h.mock, restored === 1 ? 2 : 1)).toBe('Mesmo');
  });

  it('a date and an S/N flag are restored exactly', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    const ativo = await column(h.mock, 'ativo', 3);
    const dtcad = await column(h.mock, "to_char(dtcad, 'YYYY-MM-DD')", 3);
    const flip = ativo === 'S' ? 'N' : 'S';
    const done = await run(
      h,
      cookie,
      `UPDATE TGFPAR SET ATIVO = '${flip}', DTCAD = '2001-02-03' WHERE CODPARC = 3`,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().verification).toBe('VERIFIED');
    const event = await lastExecuted(h, cookie);

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.sql).toContain(`ATIVO = '${ativo}'`);
    const back = await executePlan(h, cookie, body.plan.planId, body.plan.token);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().verification).toBe('VERIFIED');
    expect(await column(h.mock, 'ativo', 3)).toBe(ativo);
    expect(await column(h.mock, "to_char(dtcad, 'YYYY-MM-DD')", 3)).toBe(dtcad);
  });

  it('a DENY scoped to the event connection refuses the plan; nothing is prepared', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    const conn = await h.app.services.connections.create({
      name: 'Demo',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'oracle',
      secrets: { ...MOCK_CREDENTIALS },
    });
    const planned = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/preview',
      payload: {
        sql: "UPDATE TGFPAR SET NOMEPARC = 'Escopo' WHERE CODPARC = 4",
        connectionId: conn.id,
      },
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const done = await executePlan(h, cookie, planned.json().planId, planned.json().token);
    expect(done.json().verification).toBe('VERIFIED');
    const [event] = (await eventsOf(h, cookie, 'PLAN_EXECUTED')).items;
    expect(event!.connectionId).toBe(conn.id);
    // Before the rule the same caller can plan the rollback on that connection.
    expect((await rollbackPlan(h, cookie, event!.id)).statusCode).toBe(200);
    const created = (await eventsOf(h, cookie, 'PLAN_CREATED')).total;
    const linked = (await eventsOf(h, cookie, 'rollback.planned')).total;

    await h.policy({ name: 'deny this connection', connectionIds: [conn.id] });
    const res = await rollbackPlan(h, cookie, event!.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(res.body).not.toContain('token');
    expect((await eventsOf(h, cookie, 'PLAN_CREATED')).total).toBe(created);
    expect((await eventsOf(h, cookie, 'rollback.planned')).total).toBe(linked);
  });

  it('when the rollback.planned record cannot be written: a stable 5xx and no token', async () => {
    const h = await setup();
    const cookie = await h.userWith(WRITER);
    await run(h, cookie, "UPDATE TGFPAR SET NOMEPARC = 'Sem auditoria' WHERE CODPARC = 6");
    const event = await lastExecuted(h, cookie);
    const record = h.app.services.audit.record.bind(h.app.services.audit);
    vi.spyOn(h.app.services.audit, 'record').mockImplementation(async (input) => {
      if (input.action === 'rollback.planned') throw new Error('audit store down');
      return record(input);
    });

    const res = await rollbackPlan(h, cookie, event.id);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.json().error.details).toEqual({ reason: 'ROLLBACK_AUDIT_FAILED' });
    expect(res.body).not.toMatch(/token/i);
    vi.restoreAllMocks();
  });
});

describe('plans on an edited or deleted connection', () => {
  const UPDATE = "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 1";

  let n = 0;
  async function prepared(h: Harness) {
    const conn = await h.app.services.connections.create({
      name: `Stored mock ${++n}`,
      environment: 'HOMOLOGATION',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'oracle',
      secrets: { ...MOCK_CREDENTIALS },
    });
    const cookie = await h.userWith([...WRITER, 'ADMIN.CONNECTIONS']);
    const planned = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/preview',
      payload: { sql: UPDATE, connectionId: conn.id },
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const { planId, token } = planned.json() as { planId: string; token: string };
    return { conn, cookie, planId, token };
  }

  const statusOf = async (h: Harness, id: string) =>
    (await h.database.db.select({ status: plans.status }).from(plans).where(eq(plans.id, id)))[0]
      ?.status;

  it('refuses at execute a plan prepared before the connection was edited', async () => {
    const h = await setup();
    const { conn, cookie, planId, token } = await prepared(h);
    const original = await partner(h.mock, 1);
    const edit = await h.call(cookie, {
      method: 'PATCH',
      url: `/api/admin/connections/${conn.id}`,
      payload: { name: 'Renamed' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await statusOf(h, planId)).toBe('INVALIDATED');
    const res = await executePlan(h, cookie, planId, token);
    expect(res.statusCode).not.toBe(200);
    expect(res.json().error.code).toBe('CONFIRMATION_INVALID');
    expect(await partner(h.mock, 1)).toBe(original);
    expect(saves(h.mock)).toHaveLength(0);
  });

  it('invalidates the plans of a connection whose secrets are replaced or that is deleted', async () => {
    const h = await setup();
    const first = await prepared(h);
    const rotate = await h.call(first.cookie, {
      method: 'PUT',
      url: `/api/admin/connections/${first.conn.id}/secrets`,
      payload: { xToken: MOCK_CREDENTIALS.xToken },
    });
    expect(rotate.statusCode, rotate.body).toBe(200);
    expect(await statusOf(h, first.planId)).toBe('INVALIDATED');

    const second = await prepared(h);
    const del = await h.call(second.cookie, {
      method: 'DELETE',
      url: `/api/admin/connections/${second.conn.id}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    expect(await statusOf(h, second.planId)).toBe('INVALIDATED');
    expect(saves(h.mock)).toHaveLength(0);
  });
});
