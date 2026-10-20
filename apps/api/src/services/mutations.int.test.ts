import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { createDatabase, rolePermissions, roles } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import type { AuthState } from '../context';
import { ApprovalsService } from './approvals';
import { ENV_CONNECTION_ID } from './connections';
import { MutationService, renderExpr } from './mutations';
import type { PreparedMutation } from './mutations';
import { PlansService } from './plans';
import type { PolicyInput } from './policy';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';

const BASE_ENV = {
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
};

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  mock: MockSankhya;
  service: MutationService;
  approvals: ApprovalsService;
  /** A user holding exactly `permissions`, its AuthState, session cookie and role id. */
  userWith(permissions: Permission[]): Promise<{ auth: AuthState; cookie: string; roleId: string }>;
  call(
    cookie: string | null,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  policy(input: Partial<PolicyInput>): Promise<void>;
  audit(action: string): Promise<Array<Record<string, unknown>>>;
}

const open: Harness[] = [];

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const mock = await createMockSankhya();
  const app = await buildApp({
    config,
    database,
    logger: false,
    sankhya: { mockGateway: () => Promise.resolve({ ...mock, close: async () => undefined }) },
  });
  await app.services.users.create({
    email: ADMIN.email,
    name: 'Admin',
    password: ADMIN.password,
    roles: config.bootstrapAdmin.roles,
  });
  const s = app.services;
  const plans = new PlansService(database.db, { secret: config.session.secret, ttlSeconds: 300 });
  const ceilings = {
    sankhyaMaxReadRows: config.sankhya.maxRows,
    scratchMaxReadRows: config.scratch.maxRows,
  };
  const approvals = new ApprovalsService(database.db, {
    plans,
    policies: s.policies,
    authz: s.authz,
    redact: s.redact,
    ceilings,
  });
  const service = new MutationService({
    policies: s.policies,
    authz: s.authz,
    connections: s.connections,
    metadata: s.metadata,
    audit: s.audit,
    scratch: s.scratch,
    plans,
    approvals,
    security: s.security,
    switches: { safeMode: config.safeMode, writeToSankhya: config.writeToSankhya },
    maxReadRows: ceilings.sankhyaMaxReadRows,
    scratchMaxReadRows: ceilings.scratchMaxReadRows,
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
    // Inserted directly: the administrator holds no DATA.* permission it could grant.
    const [role] = await database.db
      .insert(roles)
      .values({ key, name: key })
      .returning({ id: roles.id });
    await database.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
    const email = `user${n}@example.com`;
    const user = await s.users.create({ email, name: 'User', password: PASSWORD, roles: [key] });
    const login = await call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = login.cookies.find((x) => x.name === config.session.cookieName)!.value;
    const resolved = (await s.sessions.resolve(cookie))!;
    expect(resolved.user.id).toBe(user.id);
    return {
      auth: { ...resolved, grants: await s.authz.grants(user.id) },
      cookie,
      roleId: role!.id,
    };
  };
  const policy = async (input: Partial<PolicyInput>) => {
    await s.policies.create({
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
  const audit = async (action: string) =>
    (await s.audit.list({ action, limit: 100, offset: 0 })).items as unknown as Array<
      Record<string, unknown>
    >;
  // Writes are default-deny: grant DATA.* everywhere, as an operator would for a test bench.
  await policy({ name: 'writes allowed', effect: 'ALLOW', actions: ['DATA.*'] });
  const h: Harness = { app, database, mock, service, approvals, userWith, call, policy, audit };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
    await h.mock.close();
  }
});

const WRITER: Permission[] = ['QUERY.SELECT', 'DATA.INSERT', 'DATA.UPDATE', 'DATA.DELETE'];

/** Every gateway call that is not a read. The preview must never produce one. */
const writeCalls = (mock: MockSankhya) =>
  mock.calls.filter((c) => !c.serviceName.endsWith('.executeQuery'));

const partner = async (mock: MockSankhya, id: number) =>
  (
    await mock.db.query<{ nomeparc: string }>('SELECT nomeparc FROM tgfpar WHERE codparc = $1', [
      id,
    ])
  ).rows[0]?.nomeparc;

const prepare = (h: Harness, auth: AuthState, sql: string) =>
  h.service.prepare({ auth, sql, connectionId: ENV_CONNECTION_ID });

describe('MutationService.prepare', () => {
  it('UPDATE with WHERE: real before values, simulated after values, a plan and no write', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    const before = await partner(h.mock, 1);
    const p = await prepare(h, auth, "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 1");

    expect(p.previewKind).toBe('IMPACT_ANALYSIS');
    expect(p.previewLabels).toEqual(['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW']);
    expect(p.capability).toMatchObject({ class: 'SUPPORTED', route: 'SANKHYA_SAVE' });
    expect(p.preview.affected).toBe(1);
    expect(p.preview.targets).toEqual([
      {
        key: { CODPARC: 1 },
        before: { CODPARC: 1, NOMEPARC: before },
        after: { CODPARC: 1, NOMEPARC: 'Novo nome' },
      },
    ]);
    expect(p.impact).toEqual({ entities: ['TGFPAR'], rows: 1, environment: 'HOMOLOGATION' });
    expect(p.requires).toEqual({ strongConfirmation: null, approval: false });
    expect(p.planId).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.token.startsWith(`${p.planId}.`)).toBe(true);
    const ttl = new Date(p.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(290_000);
    expect(ttl).toBeLessThanOrEqual(300_000);

    // The gateway only saw reads, and the row is unchanged.
    expect(writeCalls(h.mock)).toEqual([]);
    expect(await partner(h.mock, 1)).toBe(before);
    const created = await h.audit('PLAN_CREATED');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: 'info',
      planId: p.planId,
      capability: 'DATA.UPDATE',
    });
  });

  it('simulates arithmetic on numeric columns', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, 'UPDATE TGFPRO SET VLRVENDA = VLRVENDA * 2 WHERE CODPROD = 1');
    const [t] = p.preview.targets;
    expect(t!.after.VLRVENDA).toBeCloseTo(Number(t!.before!.VLRVENDA) * 2);
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('INSERT: a simulated preview with the new record and no gateway call at all', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(
      h,
      auth,
      "INSERT INTO TGFPAR (CODPARC, NOMEPARC, ATIVO) VALUES (9999, 'Parceiro novo', 'S')",
    );
    expect(p.previewKind).toBe('SIMULATED_PREVIEW');
    expect(p.previewLabels).toEqual(['SIMULATED_PREVIEW']);
    expect(p.preview).toEqual({
      affected: 1,
      targets: [
        {
          key: { CODPARC: 9999 },
          before: null,
          after: { CODPARC: 9999, NOMEPARC: 'Parceiro novo', ATIVO: 'S' },
        },
      ],
    });
    expect(writeCalls(h.mock)).toEqual([]);
    expect(await partner(h.mock, 9999)).toBeUndefined();
  });

  it('PRODUCTION requires the strong confirmation phrase', async () => {
    const h = await setup({ SANKHYA_ENVIRONMENT: 'PRODUCTION' });
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, "UPDATE TGFPAR SET ATIVO = 'N' WHERE CODPARC IN (1, 2)");
    expect(p.preview.affected).toBe(2);
    expect(p.requires.strongConfirmation).toBe('PRODUCTION UPDATE 2 TGFPAR');
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('blocks UPDATE and DELETE without WHERE (WHERE_REQUIRED), audited as denied', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    for (const sql of ['DELETE FROM TGFPAR', "UPDATE TGFPAR SET ATIVO = 'N'"]) {
      await expect(prepare(h, auth, sql), sql).rejects.toMatchObject({ code: 'WHERE_REQUIRED' });
    }
    expect(h.mock.calls).toEqual([]);
    const denied = await h.audit('write.denied');
    expect(denied).toHaveLength(2);
    expect(denied.map((d) => d.errorCode)).toEqual(['WHERE_REQUIRED', 'WHERE_REQUIRED']);
  });

  it('treats a trivial WHERE (1=1, always true) as missing', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    for (const sql of [
      "UPDATE TGFPAR SET ATIVO = 'N' WHERE 1=1",
      "UPDATE TGFPAR SET ATIVO = 'N' WHERE CODPARC = 1 OR 1 = 1",
      "UPDATE TGFPAR SET ATIVO = 'N' WHERE CODPARC = CODPARC",
    ]) {
      await expect(prepare(h, auth, sql), sql).rejects.toMatchObject({ code: 'WHERE_REQUIRED' });
    }
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('DELETE with WHERE on Sankhya is OPERATION_NOT_SUPPORTED with the capability reason', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    await expect(prepare(h, auth, 'DELETE FROM TGFPAR WHERE CODPARC = 1')).rejects.toMatchObject({
      code: 'OPERATION_NOT_SUPPORTED',
      message: expect.stringContaining('no documented generic delete service'),
    });
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('a policy DENY refuses the preview before any snapshot read; internals stay in the audit', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    await h.policy({ entities: ['TGFPAR'] });
    const before = h.mock.calls.length;
    const err = await prepare(h, auth, "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1").catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'FORBIDDEN', message: 'The change was denied by policy' });
    expect(
      h.mock.calls.slice(before).filter((c) => JSON.stringify(c).includes('NOMEPARC')),
    ).toEqual([]);
    expect(writeCalls(h.mock)).toEqual([]);
    const [denied] = await h.audit('write.denied');
    expect(denied).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN', resource: 'TGFPAR' });
    expect((denied!.details as Record<string, unknown>).reasons).toBeDefined();
  });

  it('refuses unparseable input (fail closed)', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    for (const sql of ['UPDATE TGFPAR SET', 'UPDATEX TGFPAR SET A = 1 WHERE B = 2', 'not sql']) {
      await expect(prepare(h, auth, sql), sql).rejects.toMatchObject({ code: 'SQL_PARSE_ERROR' });
    }
    await expect(prepare(h, auth, 'SELECT 1 FROM TGFPAR')).rejects.toMatchObject({
      code: 'SQL_UNSUPPORTED',
    });
    expect(h.mock.calls).toEqual([]);
    expect(await h.audit('write.denied')).toHaveLength(4);
  });

  it('refuses a user without the DATA.* permission of the statement kind', async () => {
    const h = await setup();
    const { auth } = await h.userWith(['QUERY.SELECT', 'DATA.INSERT']);
    await expect(
      prepare(h, auth, "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1"),
    ).rejects.toMatchObject({ code: 'FORBIDDEN', details: { permission: 'DATA.UPDATE' } });
    expect(h.mock.calls).toEqual([]);
    expect(await h.audit('write.denied')).toHaveLength(1);
  });

  it('refuses changing a primary key column and a non-simulable expression', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    await expect(
      prepare(h, auth, 'UPDATE TGFPAR SET CODPARC = 5 WHERE CODPARC = 1'),
    ).rejects.toMatchObject({ code: 'COLUMN_NOT_WRITABLE' });
    await expect(
      prepare(h, auth, 'INSERT INTO TGFPAR (CODPARC, NOMEPARC) VALUES (5, NOMEPARC)'),
    ).rejects.toMatchObject({
      code: expect.stringMatching(/OPERATION_NOT_SUPPORTED|SQL_UNSUPPORTED/),
    });
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('refuses an UPDATE whose targets exceed maxWriteRows', async () => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    await expect(
      prepare(h, auth, "UPDATE TGFPAR SET ATIVO = 'S' WHERE CODPARC > 0"),
    ).rejects.toMatchObject({ code: 'WRITE_ROW_LIMIT_EXCEEDED' });
    expect(writeCalls(h.mock)).toEqual([]);
  });
});

describe('POST /api/query/preview', () => {
  const preview = (h: Harness, cookie: string | null, payload: Record<string, unknown>) =>
    h.call(cookie, { method: 'POST', url: '/api/query/preview', payload });

  it('returns the prepared plan without secrets and writes nothing', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(WRITER);
    const res = await preview(h, cookie, {
      sql: "UPDATE TGFPAR SET NOMEPARC = 'Novo' WHERE CODPARC = 2",
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.json();
    expect(body).toMatchObject({
      type: 'preview',
      previewKind: 'IMPACT_ANALYSIS',
      previewLabels: ['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW'],
      preview: { affected: 1 },
      impact: { entities: ['TGFPAR'], rows: 1 },
      requires: { strongConfirmation: null, approval: false },
      execution: {
        available: false,
        safeMode: true,
        globalWriteEnabled: false,
        writeToSankhya: false,
      },
    });
    for (const secret of [...Object.values(MOCK_CREDENTIALS), BASE_ENV.SESSION_SECRET]) {
      expect(res.body).not.toContain(secret);
    }
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it('requires auth and same-origin, and the permission of the statement kind', async () => {
    const h = await setup();
    const payload = { sql: "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1" };
    expect((await preview(h, null, payload)).statusCode).toBe(401);
    const { cookie } = await h.userWith(['QUERY.SELECT']);
    const csrf = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/preview',
      payload,
      headers: { origin: 'https://evil.example.com' },
    });
    expect(csrf.statusCode).toBe(403);
    expect(csrf.json().error.code).toBe('CSRF_REJECTED');
    const res = await preview(h, cookie, payload);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect(await h.audit('write.denied')).toHaveLength(1);
    expect(h.mock.calls).toEqual([]);
  });

  it('/api/query answers a mutation with a pointer to the preview and never plans or writes', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(WRITER);
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'SQL_UNSUPPORTED',
      details: { preview: '/api/query/preview' },
    });
    expect(h.mock.calls).toEqual([]);
    expect(await h.audit('PLAN_CREATED')).toHaveLength(0);
  });

  it('/api/query/confirm stays denied, even with a valid plan token', async () => {
    const h = await setup({
      SAFE_MODE: 'false',
      GLOBAL_WRITE_ENABLED: 'true',
      WRITE_TO_SANKHYA: 'true',
    });
    const { cookie } = await h.userWith(WRITER);
    const sql = "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1";
    const planned = await preview(h, cookie, { sql });
    expect(planned.statusCode, planned.body).toBe(200);
    const before = await partner(h.mock, 1);
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/confirm',
      payload: { sql, token: planned.json().token as string },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('SQL_UNSUPPORTED');
    expect(writeCalls(h.mock)).toEqual([]);
    expect(await partner(h.mock, 1)).toBe(before);
  });
});

describe('WHERE fidelity of the snapshot', () => {
  // Each renders to an equivalent predicate: the planned targets equal what a direct SELECT with
  // the original WHERE returns on the mock.
  const FAITHFUL = [
    'CODPARC = 1 OR CODPARC = 2',
    'CODPARC IN (1, 2, 3)',
    'CODPARC NOT IN (1, 2) AND CODPARC < 20',
    'CODPARC BETWEEN 2 AND 3',
    'CODPARC NOT BETWEEN 2 AND 1000000 AND CODPARC < 20',
    "CODPARC < 20 AND NOMEPARC LIKE '%a%'",
    "CODPARC < 20 AND NOMEPARC NOT LIKE '%a%'",
    'NOMEPARC IS NULL',
    'NOMEPARC IS NOT NULL AND CODPARC > 2 AND CODPARC < 20',
    'CODPARC - 1 = -(-1)',
    'CODPARC = - -1',
    'CODPARC = 1 /* trailing */',
  ];
  // Constructs the renderer cannot reproduce faithfully: the preview must refuse, never alter them.
  const REFUSED: Array<[string, string]> = [
    ['NOT (CODPARC > 2)', 'SQL_UNSUPPORTED'],
    ['UPPER(NOMEPARC) = NOMEPARC', 'OPERATION_NOT_SUPPORTED'],
    ['CODPARC IN (SELECT CODPARC FROM TGFPAR WHERE CODPARC = 1)', 'OPERATION_NOT_SUPPORTED'],
    ['CASE WHEN CODPARC = 1 THEN 1 ELSE 0 END = 1', 'OPERATION_NOT_SUPPORTED'],
    ['CAST(CODPARC AS VARCHAR(10)) = 1', 'OPERATION_NOT_SUPPORTED'],
    ['EXISTS (SELECT 1 FROM TGFPAR)', 'OPERATION_NOT_SUPPORTED'],
    ['CODPARC = (SELECT MAX(CODPARC) FROM TGFPAR)', 'OPERATION_NOT_SUPPORTED'],
  ];

  it.each(FAITHFUL)('renders an equivalent predicate: %s', async (where) => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    const direct = (
      await h.mock.db.query<{ codparc: number }>(`SELECT codparc FROM tgfpar WHERE ${where}`)
    ).rows
      .map((x) => x.codparc)
      .sort((a, b) => a - b);
    const planned = await prepare(h, auth, `UPDATE TGFPAR SET ATIVO = 'N' WHERE ${where}`);
    const keys = planned.preview.targets.map((t) => Number(t.key.CODPARC)).sort((a, b) => a - b);
    expect(keys).toEqual(direct);
    expect(writeCalls(h.mock)).toEqual([]);
  });

  it.each(REFUSED)('refuses what it cannot render faithfully: %s', async (where, code) => {
    const h = await setup();
    const { auth } = await h.userWith(WRITER);
    await expect(
      prepare(h, auth, `UPDATE TGFPAR SET ATIVO = 'N' WHERE ${where}`),
    ).rejects.toMatchObject({ code });
    expect(writeCalls(h.mock)).toEqual([]);
    expect(await h.audit('write.denied')).toHaveLength(1);
    expect(await h.audit('PLAN_CREATED')).toHaveLength(0);
  });
});

describe('scratch TRANSACTIONAL_DRY_RUN', () => {
  const SCRATCH: Permission[] = ['TEMP.CREATE', 'TEMP.WRITE', 'QUERY.SELECT'];

  async function withTable(h: Harness, auth: AuthState) {
    const ws = await h.app.services.scratch.workspace(auth.user.id);
    await ws.exec('CREATE TABLE tmp_a (id int, v text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'x'), (2, 'y'), (3, 'z')");
    return ws;
  }

  it('UPDATE: before/after rows and affected count, rolled back, with a plan', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    const ws = await withTable(h, auth);
    const p = await prepare(h, auth, "UPDATE tmp_a SET v = 'new' WHERE id = 2");
    expect(p.previewKind).toBe('TRANSACTIONAL_DRY_RUN');
    expect(p.previewLabels).toEqual(['TRANSACTIONAL_DRY_RUN']);
    expect(p.capability).toMatchObject({ class: 'SCRATCH_ONLY', route: 'SCRATCH' });
    expect(p.preview.affected).toBe(1);
    expect(p.preview.targets).toEqual([
      { key: {}, before: { id: 2, v: 'y' }, after: { id: 2, v: 'new' } },
    ]);
    expect(p.impact).toEqual({ entities: ['TMP_A'], rows: 1, environment: 'SANDBOX' });
    expect(p.planId).toMatch(/^[0-9a-f-]{36}$/);
    // Nothing persisted, nothing sent to Sankhya.
    expect((await ws.exec('SELECT id, v FROM tmp_a ORDER BY id')).rows).toEqual([
      [1, 'x'],
      [2, 'y'],
      [3, 'z'],
    ]);
    expect(h.mock.calls).toEqual([]);
    expect(await h.audit('PLAN_CREATED')).toHaveLength(1);
  });

  it('INSERT and DELETE dry runs report their rows', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    const ws = await withTable(h, auth);
    const ins = await prepare(h, auth, "INSERT INTO tmp_a VALUES (4, 'w')");
    expect(ins.preview.targets).toEqual([{ key: {}, before: null, after: { id: 4, v: 'w' } }]);
    const del = await prepare(h, auth, 'DELETE FROM tmp_a WHERE id = 1');
    expect(del.preview.targets).toEqual([{ key: {}, before: { id: 1, v: 'x' }, after: {} }]);
    expect((await ws.tables())[0]).toMatchObject({ name: 'tmp_a', rows: 3 });
  });

  it('refuses a policy DENY before running anything, audited as denied', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    const ws = await withTable(h, auth);
    await h.policy({ actions: ['TEMP.WRITE'] });
    await expect(prepare(h, auth, "UPDATE tmp_a SET v = 'n' WHERE id = 2")).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await h.audit('write.denied')).toHaveLength(1);
    expect(await h.audit('PLAN_CREATED')).toHaveLength(0);
    expect((await ws.exec('SELECT v FROM tmp_a WHERE id = 2')).rows).toEqual([['y']]);
  });

  it('refuses without TEMP.WRITE, without WHERE, and for a table the caller does not have', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    await withTable(h, auth);
    await expect(prepare(h, auth, 'DELETE FROM tmp_a')).rejects.toMatchObject({
      code: 'WHERE_REQUIRED',
    });
    await expect(prepare(h, auth, 'DELETE FROM tmp_other WHERE id = 1')).rejects.toMatchObject({
      code: 'OPERATION_NOT_SUPPORTED',
    });
    const reader = await h.userWith(['QUERY.SELECT', 'DATA.UPDATE']);
    await expect(
      prepare(h, reader.auth, "UPDATE tmp_a SET v = 'n' WHERE id = 2"),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses when the table exceeds the preview cap: no plan, table unchanged', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    const ws = await h.app.services.scratch.workspace(auth.user.id);
    await ws.exec('CREATE TABLE tmp_big (id int, v text)');
    await ws.exec("INSERT INTO tmp_big SELECT g, 'v' || g FROM generate_series(1, 300) g");
    // A truncated snapshot would pair the old row 5 with an unrelated row sliding into the window.
    await expect(
      prepare(h, auth, "UPDATE tmp_big SET v = 'changed' WHERE id = 5"),
    ).rejects.toMatchObject({
      code: 'OPERATION_NOT_SUPPORTED',
      details: { reason: 'SNAPSHOT_TRUNCATED' },
    });
    expect(await h.audit('write.denied')).toHaveLength(1);
    expect(await h.audit('PLAN_CREATED')).toHaveLength(0);
    expect((await ws.exec("SELECT count(*)::int FROM tmp_big WHERE v = 'changed'")).rows).toEqual([
      [0],
    ]);
    expect((await ws.exec('SELECT v FROM tmp_big WHERE id = 5')).rows).toEqual([['v5']]);
    expect((await ws.exec('SELECT count(*)::int FROM tmp_big')).rows).toEqual([[300]]);
  });

  it('enforces a maxWriteRows rule on the dry run', async () => {
    const h = await setup();
    const { auth } = await h.userWith(SCRATCH);
    await withTable(h, auth);
    await h.policy({
      name: 'cap',
      effect: 'ALLOW',
      actions: ['TEMP.WRITE'],
      limits: { maxWriteRows: 1 },
    });
    await expect(prepare(h, auth, "UPDATE tmp_a SET v = 'n' WHERE id > 0")).rejects.toMatchObject({
      code: 'WRITE_ROW_LIMIT_EXCEEDED',
    });
  });
});

describe('renderExpr', () => {
  it('never produces a line comment from a negated negative literal', () => {
    const lit = { kind: 'literal', value: -5 } as const;
    const sql = renderExpr({ kind: 'neg', expr: lit }, new Set(), new Set());
    expect(sql).not.toContain('--');
    expect(sql).toBe('(- -5)');
    const nested = renderExpr(
      { kind: 'neg', expr: { kind: 'neg', expr: lit } },
      new Set(),
      new Set(),
    );
    expect(nested).not.toContain('--');
  });
});

describe('read audit', () => {
  it('records read.executed with connection, row count and statement, never the rows', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(['QUERY.SELECT']);
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC IN (1, 2)' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const rows = res.json().rows as unknown[][];
    expect(rows).toHaveLength(2);
    const events = await h.audit('read.executed');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      status: 'success',
      operation: 'SELECT',
      resource: 'TGFPAR',
      connectionId: ENV_CONNECTION_ID,
      statement: 'SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC IN (1, 2)',
      details: { connectionId: ENV_CONNECTION_ID, rowCount: 2, truncated: false },
    });
    const stored = JSON.stringify(events[0]);
    for (const row of rows) expect(stored).not.toContain(String(row[1]));
  });
});

// ------------------------------------------------------------------------------------ execute

/** Every write switch on: SAFE_MODE off, GLOBAL_WRITE_ENABLED and WRITE_TO_SANKHYA on. */
const WRITES = { SAFE_MODE: 'false', GLOBAL_WRITE_ENABLED: 'true', WRITE_TO_SANKHYA: 'true' };

const saves = (mock: MockSankhya) => mock.calls.filter((c) => c.serviceName === 'DatasetSP.save');

const execute = (
  h: Harness,
  auth: AuthState,
  p: PreparedMutation,
  extra: { strongConfirmation?: string; idempotencyKey?: string; token?: string } = {},
) =>
  h.service.execute({
    auth,
    planId: p.planId,
    token: extra.token ?? p.token,
    idempotencyKey: extra.idempotencyKey ?? randomUUID(),
    ...(extra.strongConfirmation !== undefined
      ? { strongConfirmation: extra.strongConfirmation }
      : {}),
  });

describe('MutationService.execute', () => {
  const SQL = "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 1";

  it('the first submit never writes; execute writes, verifies (VERIFIED) and audits', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const before = await partner(h.mock, 1);
    const p = await prepare(h, auth, SQL);
    expect(saves(h.mock)).toEqual([]);
    expect(await partner(h.mock, 1)).toBe(before);

    const report = await execute(h, auth, p);
    expect(report).toMatchObject({
      status: 'success',
      verification: 'VERIFIED',
      steps: [{ key: { CODPARC: 1 }, outcome: 'ok', verified: true }],
    });
    expect(saves(h.mock)).toHaveLength(1);
    expect(await partner(h.mock, 1)).toBe('Novo nome');

    const [executed] = await h.audit('PLAN_EXECUTED');
    expect(executed).toMatchObject({
      status: 'success',
      planId: p.planId,
      capability: 'DATA.UPDATE',
      errorCode: null,
    });
    const [verification] = await h.audit('VERIFICATION');
    expect(verification).toMatchObject({ status: 'success', planId: p.planId });
  });

  it('a row changed between prepare and execute: TARGETS_CHANGED, nothing saved', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await h.mock.db.query("UPDATE tgfpar SET nomeparc = 'Mudou' WHERE codparc = 1");
    await expect(execute(h, auth, p)).rejects.toMatchObject({ code: 'TARGETS_CHANGED' });
    expect(saves(h.mock)).toEqual([]);
    expect(await partner(h.mock, 1)).toBe('Mudou');
    const [denied] = await h.audit('PLAN_DENIED');
    expect(denied).toMatchObject({ errorCode: 'TARGETS_CHANGED', planId: p.planId });
  });

  it('DATA.UPDATE removed after the preview: FORBIDDEN, nothing saved, audited as denied', async () => {
    const h = await setup(WRITES);
    const { auth, roleId } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await h.database.db
      .delete(rolePermissions)
      .where(
        and(eq(rolePermissions.roleId, roleId), eq(rolePermissions.permission, 'DATA.UPDATE')),
      );
    await expect(execute(h, auth, p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(saves(h.mock)).toEqual([]);
    const [denied] = await h.audit('PLAN_DENIED');
    expect(denied).toMatchObject({ status: 'denied', errorCode: 'FORBIDDEN', planId: p.planId });
  });

  it('a policy change after the preview: CONFIRMATION_INVALID, nothing saved', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await h.policy({ name: 'unrelated', actions: ['DATA.DELETE'], entities: ['TGFPRO'] });
    await expect(execute(h, auth, p)).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(saves(h.mock)).toEqual([]);
    expect(await h.audit('PLAN_DENIED')).toHaveLength(1);
  });

  it('GLOBAL_WRITE_ENABLED=false: READ_ONLY_MODE, nothing saved', async () => {
    const h = await setup({ SAFE_MODE: 'false', WRITE_TO_SANKHYA: 'true' });
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await expect(execute(h, auth, p)).rejects.toMatchObject({
      code: 'READ_ONLY_MODE',
      details: { switch: 'GLOBAL_WRITE_ENABLED' },
    });
    expect(saves(h.mock)).toEqual([]);
    expect(await h.audit('PLAN_DENIED')).toHaveLength(1);
  });

  it('the runtime kill switch turned off: READ_ONLY_MODE, nothing saved', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await h.app.services.security.setGlobalWrite(false, null);
    await expect(execute(h, auth, p)).rejects.toMatchObject({ code: 'READ_ONLY_MODE' });
    expect(saves(h.mock)).toEqual([]);
  });

  it('WRITE_TO_SANKHYA=false: READ_ONLY_MODE, nothing saved', async () => {
    const h = await setup({ SAFE_MODE: 'false', GLOBAL_WRITE_ENABLED: 'true' });
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    await expect(execute(h, auth, p)).rejects.toMatchObject({
      code: 'READ_ONLY_MODE',
      details: { switch: 'WRITE_TO_SANKHYA' },
    });
    expect(saves(h.mock)).toEqual([]);
  });

  it('PRODUCTION with SAFE_MODE=true: READ_ONLY_MODE even with the phrase', async () => {
    const h = await setup({
      GLOBAL_WRITE_ENABLED: 'true',
      WRITE_TO_SANKHYA: 'true',
      SANKHYA_ENVIRONMENT: 'PRODUCTION',
    });
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    expect(p.requires.strongConfirmation).toBe('PRODUCTION UPDATE 1 TGFPAR');
    await expect(
      execute(h, auth, p, { strongConfirmation: p.requires.strongConfirmation! }),
    ).rejects.toMatchObject({ code: 'READ_ONLY_MODE', details: { switch: 'SAFE_MODE' } });
    expect(saves(h.mock)).toEqual([]);
  });

  it('PRODUCTION with SAFE_MODE=false needs the exact phrase, then writes', async () => {
    const h = await setup({ ...WRITES, SANKHYA_ENVIRONMENT: 'PRODUCTION' });
    const { auth } = await h.userWith(WRITER);
    const wrong = await prepare(h, auth, SQL);
    await expect(
      execute(h, auth, wrong, { strongConfirmation: 'PRODUCTION UPDATE 2 TGFPAR' }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' });
    expect(saves(h.mock)).toEqual([]);
    expect(await h.audit('write.denied')).toHaveLength(1);
    const p = await prepare(h, auth, SQL);
    const report = await execute(h, auth, p, {
      strongConfirmation: p.requires.strongConfirmation!,
    });
    expect(report.verification).toBe('VERIFIED');
  });

  it('UPDATE without WHERE stays WHERE_REQUIRED and DELETE on Sankhya OPERATION_NOT_SUPPORTED', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    await expect(prepare(h, auth, "UPDATE TGFPAR SET ATIVO = 'N'")).rejects.toMatchObject({
      code: 'WHERE_REQUIRED',
    });
    await expect(prepare(h, auth, 'DELETE FROM TGFPAR WHERE CODPARC = 1')).rejects.toMatchObject({
      code: 'OPERATION_NOT_SUPPORTED',
    });
    expect(saves(h.mock)).toEqual([]);
  });

  it('a definite failure on the 2nd save: partial, the 3rd step not attempted', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const names = [await partner(h.mock, 1), await partner(h.mock, 2), await partner(h.mock, 3)];
    const p = await prepare(
      h,
      auth,
      "UPDATE TGFPAR SET NOMEPARC = 'Lote' WHERE CODPARC IN (1, 2, 3)",
    );
    h.mock.inject({ type: 'rateLimited' }, { service: 'DatasetSP.save', after: 1 });
    const report = await execute(h, auth, p);
    expect(report.status).toBe('partial');
    expect(report.verification).toBe('PARTIALLY_VERIFIED');
    expect(report.steps.map((s) => s.outcome)).toEqual(['ok', 'error', 'not_attempted']);
    expect(report.steps[0]!.verified).toBe(true);
    expect(report.steps[1]!.errorCode).toBe('SANKHYA_RATE_LIMITED');
    expect(saves(h.mock)).toHaveLength(2);
    expect(await partner(h.mock, 1)).toBe('Lote');
    expect(await partner(h.mock, 2)).toBe(names[1]);
    expect(await partner(h.mock, 3)).toBe(names[2]);
    const [executed] = await h.audit('PLAN_EXECUTED');
    expect(executed).toMatchObject({ status: 'partial', errorCode: 'SANKHYA_RATE_LIMITED' });
  });

  it('the verification read fails: UNVERIFIED, never VERIFIED', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    h.mock.inject({ type: 'malformed' }, { service: 'CRUDServiceProvider.loadRecords' });
    const report = await execute(h, auth, p);
    expect(report).toMatchObject({ status: 'success', verification: 'UNVERIFIED' });
    expect(report.steps[0]!.verified).toBeUndefined();
    expect(await partner(h.mock, 1)).toBe('Novo nome');
    const [verification] = await h.audit('VERIFICATION');
    expect(verification).toMatchObject({ status: 'failed' });
  });

  it('a value the gateway silently ignored: FAILED', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const before = await partner(h.mock, 1);
    const p = await prepare(h, auth, SQL);
    h.mock.inject({ type: 'ignoreWrite' }, { service: 'DatasetSP.save' });
    const report = await execute(h, auth, p);
    expect(report.verification).toBe('FAILED');
    expect(report.steps[0]).toMatchObject({ outcome: 'ok', verified: false });
    expect(await partner(h.mock, 1)).toBe(before);
  });

  it('a save timeout: the step is unknown with WRITE_OUTCOME_UNKNOWN, never retried', async () => {
    const h = await setup({ ...WRITES, SANKHYA_TIMEOUT_MS: '1000' });
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    h.mock.inject({ type: 'delay', ms: 1500 }, { service: 'DatasetSP.save' });
    const report = await execute(h, auth, p);
    expect(report.steps[0]).toMatchObject({
      outcome: 'unknown',
      errorCode: 'WRITE_OUTCOME_UNKNOWN',
    });
    expect(report.status).not.toBe('success');
    expect(report.verification).not.toBe('VERIFIED');
    expect(saves(h.mock)).toHaveLength(1);
    const [executed] = await h.audit('PLAN_EXECUTED');
    expect(executed).toMatchObject({ errorCode: 'WRITE_OUTCOME_UNKNOWN' });
  });

  it('the same idempotency key twice runs once and returns the same report', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    const key = randomUUID();
    const first = await execute(h, auth, p, { idempotencyKey: key });
    const second = await execute(h, auth, p, { idempotencyKey: key });
    expect(second).toEqual(first);
    expect(saves(h.mock)).toHaveLength(1);
    expect(await h.audit('PLAN_EXECUTED')).toHaveLength(1);
    await expect(execute(h, auth, p, { idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: 'CONFIRMATION_USED',
    });
    expect(saves(h.mock)).toHaveLength(1);
  });

  it('an invalid token is refused before anything runs, and audited', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    const p = await prepare(h, auth, SQL);
    const forged = `${p.planId}.${'A'.repeat(43)}`;
    await expect(execute(h, auth, p, { token: forged })).rejects.toMatchObject({
      code: 'CONFIRMATION_INVALID',
    });
    expect(saves(h.mock)).toEqual([]);
    const [denied] = await h.audit('write.denied');
    expect(denied).toMatchObject({ errorCode: 'CONFIRMATION_INVALID' });
    expect((denied!.details as Record<string, unknown>).stage).toBe('CONFIRM');
  });

  it('UPDATE without WHERE under an explicit override: phrase plus four-eyes approval, then executes', async () => {
    // SANKHYA_MAX_ROWS above the policy default also checks that approvals use the same ceilings.
    const h = await setup({ ...WRITES, SANKHYA_MAX_ROWS: '5000' });
    const { auth } = await h.userWith(WRITER);
    const approver = await h.userWith(['APPROVAL.DECIDE', 'DATA.UPDATE', 'QUERY.SELECT']);
    const sql = "UPDATE TSICID SET UF = 'XX'";
    await expect(prepare(h, auth, sql)).rejects.toMatchObject({ code: 'WHERE_REQUIRED' });
    await h.policy({
      name: 'cities bulk update',
      effect: 'ALLOW',
      actions: ['DATA.UPDATE'],
      entities: ['TSICID'],
      overrideWhereRequired: true,
    });
    const p = await prepare(h, auth, sql);
    expect(p.preview.affected).toBe(12);
    expect(p.requires).toEqual({
      strongConfirmation: 'HOMOLOGATION UPDATE 12 TSICID',
      approval: true,
    });
    expect(saves(h.mock)).toEqual([]);
    const phrase = { strongConfirmation: p.requires.strongConfirmation! };

    // Not approved yet: refused without consuming the plan.
    await expect(execute(h, auth, p, phrase)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(saves(h.mock)).toEqual([]);

    const approval = await h.approvals.request(p.planId, auth.user.id);
    await h.approvals.decide(approval.id, approver.auth.user.id, 'APPROVE', null);
    const report = await execute(h, auth, p, phrase);
    expect(report).toMatchObject({ status: 'success', verification: 'VERIFIED' });
    expect(report.steps).toHaveLength(12);
    expect(saves(h.mock)).toHaveLength(12);
    const left = await h.mock.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tsicid WHERE uf <> 'XX'",
    );
    expect(left.rows[0]!.n).toBe(0);
    const [executed] = await h.audit('PLAN_EXECUTED');
    expect(executed).toMatchObject({ approvalId: approval.id });
  });

  it('DELETE without WHERE stays refused even with an override rule', async () => {
    const h = await setup(WRITES);
    const { auth } = await h.userWith(WRITER);
    await h.policy({
      name: 'override',
      effect: 'ALLOW',
      actions: ['DATA.DELETE'],
      entities: ['TSICID'],
      overrideWhereRequired: true,
    });
    await expect(prepare(h, auth, 'DELETE FROM TSICID')).rejects.toMatchObject({
      code: 'WHERE_REQUIRED',
    });
    expect(h.mock.calls).toEqual([]);
  });

  it('scratch: executes for real in the caller workspace and verifies, without Sankhya', async () => {
    const h = await setup({ GLOBAL_WRITE_ENABLED: 'true' });
    const { auth } = await h.userWith(['TEMP.CREATE', 'TEMP.WRITE', 'QUERY.SELECT']);
    const ws = await h.app.services.scratch.workspace(auth.user.id);
    await ws.exec('CREATE TABLE tmp_a (id int, v text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'x'), (2, 'y'), (3, 'z')");
    const p = await prepare(h, auth, "UPDATE tmp_a SET v = 'new' WHERE id = 2");
    const report = await execute(h, auth, p);
    expect(report).toMatchObject({ status: 'success', verification: 'VERIFIED' });
    expect((await ws.exec('SELECT id, v FROM tmp_a ORDER BY id')).rows).toEqual([
      [1, 'x'],
      [2, 'new'],
      [3, 'z'],
    ]);
    expect(h.mock.calls).toEqual([]);
    expect(await h.audit('PLAN_EXECUTED')).toHaveLength(1);
  });

  it('scratch: a table changed after the preview gives TARGETS_CHANGED', async () => {
    const h = await setup({ GLOBAL_WRITE_ENABLED: 'true' });
    const { auth } = await h.userWith(['TEMP.CREATE', 'TEMP.WRITE', 'QUERY.SELECT']);
    const ws = await h.app.services.scratch.workspace(auth.user.id);
    await ws.exec('CREATE TABLE tmp_a (id int, v text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'x'), (2, 'y')");
    const p = await prepare(h, auth, "UPDATE tmp_a SET v = 'new' WHERE id = 2");
    await ws.exec("UPDATE tmp_a SET v = 'other' WHERE id = 2");
    await expect(execute(h, auth, p)).rejects.toMatchObject({ code: 'TARGETS_CHANGED' });
    expect((await ws.exec('SELECT v FROM tmp_a WHERE id = 2')).rows).toEqual([['other']]);
  });
});

describe('POST /api/query/execute', () => {
  const SQL = "UPDATE TGFPAR SET NOMEPARC = 'Via rota' WHERE CODPARC = 4";

  it('previews (available), then executes with the token and idempotency key', async () => {
    const h = await setup(WRITES);
    const { cookie } = await h.userWith(WRITER);
    const planned = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/preview',
      payload: { sql: SQL },
    });
    expect(planned.statusCode, planned.body).toBe(200);
    expect(planned.json().execution).toMatchObject({ available: true });
    expect(saves(h.mock)).toEqual([]);
    const { planId, token } = planned.json() as { planId: string; token: string };
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/execute',
      payload: { planId, token, idempotencyKey: randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.json()).toMatchObject({
      type: 'execution',
      planId,
      status: 'success',
      verification: 'VERIFIED',
    });
    expect(await partner(h.mock, 4)).toBe('Via rota');
    for (const secret of [...Object.values(MOCK_CREDENTIALS), BASE_ENV.SESSION_SECRET]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('requires auth, same-origin and a valid body; switches off answer 403 READ_ONLY_MODE', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(WRITER);
    const planned = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/preview',
      payload: { sql: SQL },
    });
    const { planId, token } = planned.json() as { planId: string; token: string };
    const payload = { planId, token, idempotencyKey: randomUUID() };
    const url = '/api/query/execute';
    expect((await h.call(null, { method: 'POST', url, payload })).statusCode).toBe(401);
    const csrf = await h.call(cookie, {
      method: 'POST',
      url,
      payload,
      headers: { origin: 'https://evil.example.com' },
    });
    expect(csrf.statusCode).toBe(403);
    const bad = await h.call(cookie, { method: 'POST', url, payload: { planId, token } });
    expect(bad.statusCode).toBe(400);
    const res = await h.call(cookie, { method: 'POST', url, payload });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('READ_ONLY_MODE');
    expect(saves(h.mock)).toEqual([]);
  });
});
