import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from './app';
import { loadConfig, secretValues } from './config';
import { loggerOptions } from './logger';
import type { PolicyInput } from './services/policy';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';
const UNKNOWN_CONNECTION = '00000000-0000-4000-8000-00000000dead';

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
  SCRATCH_MAX_WORKSPACES: '4',
};

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  mock: MockSankhya;
  logs: string[];
  login(email?: string, password?: string): Promise<string>;
  /** A user holding exactly `permissions` (through a custom role) and its session cookie. */
  userWith(permissions: Permission[]): Promise<{ cookie: string; id: string }>;
  viewer(): Promise<{ cookie: string; id: string }>;
  call(
    cookie: string | null,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  policy(input: Partial<PolicyInput>): Promise<void>;
}

const open: Harness[] = [];

async function setup(
  env: Record<string, string> = {},
  before?: (database: DatabaseHandle) => Promise<void>,
): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  if (before) await before(database);
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const mock = await createMockSankhya();
  const app = await buildApp({
    config,
    database,
    logger: { ...(loggerOptions('info', secretValues(config)) as object), stream },
    sankhya: { mockGateway: () => Promise.resolve({ ...mock, close: async () => undefined }) },
  });
  // The first administrator, with the BOOTSTRAP_ADMIN_ROLES roles.
  const admin = await app.services.users.create({
    email: ADMIN.email,
    name: config.bootstrapAdmin.name,
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
  const login = async (email = ADMIN.email, password = ADMIN.password) => {
    const res = await call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.cookies.find((x) => x.name === config.session.cookieName)!.value;
  };
  let n = 0;
  const create = async (roles: string[]) => {
    const email = `user${++n}@example.com`;
    const user = await app.services.users.create({
      email,
      name: 'User',
      password: PASSWORD,
      roles,
    });
    return { cookie: await login(email, PASSWORD), id: user.id };
  };
  const userWith = async (permissions: Permission[]) => {
    const key = `CUSTOM_${++n}`;
    await app.services.authz.createRole({ key, name: key, permissions }, admin.id);
    return create([key]);
  };
  const policy = async (input: Partial<PolicyInput>) => {
    await app.services.policies.create({
      name: 'test rule',
      effect: 'DENY',
      subjectType: 'everyone',
      subjectId: null,
      environments: [],
      connectionIds: [],
      actions: ['QUERY.SELECT'],
      entities: [],
      columns: [],
      limits: {},
      overrideWhereRequired: false,
      enabled: true,
      ...input,
    });
  };
  const h: Harness = {
    app,
    database,
    mock,
    logs,
    login,
    userWith,
    viewer: () => create(['VIEWER']),
    call,
    policy,
  };
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

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;
const errorOf = (res: { json(): unknown }) => {
  const { error } = res.json() as { error: { code: string; message: string } };
  return { code: error.code, message: error.message };
};
const reads = (mock: MockSankhya, needle: string) =>
  mock.calls.filter(
    (c) => c.serviceName === 'DbExplorerSP.executeQuery' && JSON.stringify(c).includes(needle),
  ).length;

const query = (h: Harness, cookie: string, payload: Record<string, unknown>) =>
  h.call(cookie, { method: 'POST', url: '/api/query', payload });
const exec = (h: Harness, cookie: string, sqlText: string) =>
  h.call(cookie, { method: 'POST', url: '/api/scratch/exec', payload: { sql: sqlText } });
const materialize = (h: Harness, cookie: string, payload: Record<string, unknown>) =>
  h.call(cookie, { method: 'POST', url: '/api/scratch/materialize', payload });
const tables = async (h: Harness, cookie: string) => {
  const res = await h.call(cookie, { method: 'GET', url: '/api/scratch/tables' });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { tables: Array<{ name: string; rows: number }> }).tables;
};

describe('policies on the Sankhya read path', () => {
  it('a column DENY refuses SELECT * (expanded from the catalog) and allows other columns', async () => {
    const h = await setup();
    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    const { cookie } = await h.viewer();
    const ok = await query(h, cookie, { sql: 'SELECT NOMEPARC FROM TGFPAR' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().rowCount).toBeGreaterThan(0);

    for (const sqlText of [
      'SELECT * FROM TGFPAR',
      'SELECT EMAIL FROM TGFPAR',
      'SELECT p.NOMEPARC FROM TGFPAR p WHERE p.EMAIL IS NOT NULL',
    ]) {
      const res = await query(h, cookie, { sql: sqlText });
      expect(res.statusCode, sqlText).toBe(403);
      expect(codeOf(res), sqlText).toBe('FORBIDDEN');
      // Denied before the gateway: no rule internals leak to the user.
      expect(res.body).not.toContain('test rule');
    }
    expect(reads(h.mock, 'EMAIL')).toBe(0);

    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=read.denied' });
    expect(audit.json().total).toBe(3);
    expect(audit.json().items[0]).toMatchObject({ errorCode: 'FORBIDDEN', resource: 'TGFPAR' });
  });

  it('refuses NATURAL and condition-less joins that would hide a denied column', async () => {
    const h = await setup();
    await h.policy({ columns: ['TSICID.CODCID'] });
    const { cookie } = await h.viewer();
    for (const sqlText of [
      'SELECT NOMEPARC FROM TGFPAR NATURAL JOIN TSICID',
      'SELECT NOMEPARC FROM TGFPAR NATURAL INNER JOIN TSICID',
      'SELECT NOMEPARC FROM TGFPAR LEFT JOIN TSICID',
    ]) {
      const res = await query(h, cookie, { sql: sqlText });
      expect(res.statusCode, sqlText).toBe(400);
      expect(codeOf(res), sqlText).toBe('SQL_UNSUPPORTED');
    }
    expect(reads(h.mock, 'TSICID')).toBe(0);
  });

  it('allows COUNT(*) under a column DENY', async () => {
    const h = await setup();
    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    const { cookie } = await h.viewer();
    const ok = await query(h, cookie, { sql: 'SELECT COUNT(*) FROM TGFPAR' });
    expect(ok.statusCode, ok.body).toBe(200);
    for (const sqlText of ['SELECT * FROM TGFPAR', 'SELECT COUNT(EMAIL) FROM TGFPAR']) {
      const res = await query(h, cookie, { sql: sqlText });
      expect(res.statusCode, sqlText).toBe(403);
    }
  });

  it("caps the rows at the policy's maxReadRows", async () => {
    const h = await setup();
    await h.policy({ effect: 'ALLOW', entities: ['TGFPAR'], limits: { maxReadRows: 3 } });
    const { cookie } = await h.viewer();
    const res = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ rowCount: 3, truncated: true });
    expect(res.json().messages.join(' ')).toContain('3 rows');
    // The rule only applies to its entities.
    const other = await query(h, cookie, { sql: 'SELECT CODCID FROM TSICID' });
    expect(other.json().rowCount).toBeGreaterThan(3);
  });

  it('keeps SANKHYA_MAX_ROWS as the ceiling rules cannot raise', async () => {
    const h = await setup({ SANKHYA_MAX_ROWS: '4' });
    await h.policy({ effect: 'ALLOW', limits: { maxReadRows: 50 } });
    const { cookie } = await h.viewer();
    const res = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR' });
    expect(res.json()).toMatchObject({ rowCount: 4, truncated: true });
  });
});

describe('per-connection authorization (SR1)', () => {
  it('answers a denied and an unknown connection the same way, before any gateway call', async () => {
    const h = await setup();
    const conn = await h.app.services.connections.create({
      name: 'Demo',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'oracle',
      secrets: { ...MOCK_CREDENTIALS },
    });
    await h.policy({ connectionIds: [conn.id] });
    const { cookie } = await h.viewer();
    const sqlText = 'SELECT CODPARC FROM TGFPAR';

    const denied = await query(h, cookie, { sql: sqlText, connectionId: conn.id });
    const unknown = await query(h, cookie, { sql: sqlText, connectionId: UNKNOWN_CONNECTION });
    expect(denied.statusCode).toBe(403);
    expect(unknown.statusCode).toBe(403);
    expect(errorOf(denied)).toEqual(errorOf(unknown));
    expect(errorOf(denied).code).toBe('FORBIDDEN');

    const schemaDenied = await h.call(cookie, {
      method: 'GET',
      url: `/api/schema?connectionId=${conn.id}`,
    });
    const schemaUnknown = await h.call(cookie, {
      method: 'GET',
      url: `/api/schema?connectionId=${UNKNOWN_CONNECTION}`,
    });
    expect(schemaDenied.statusCode).toBe(403);
    expect(errorOf(schemaDenied)).toEqual(errorOf(schemaUnknown));
    expect(errorOf(schemaDenied)).toEqual(errorOf(denied));
    expect(h.mock.calls).toHaveLength(0);

    // The rule names one connection: the env-defined one still works.
    const env = await query(h, cookie, { sql: sqlText });
    expect(env.statusCode, env.body).toBe(200);
  });

  it('applies rules without a connection list to env-default, in its SANKHYA_ENVIRONMENT', async () => {
    const h = await setup({ SANKHYA_ENVIRONMENT: 'HOMOLOGATION' });
    await h.policy({ environments: ['PRODUCTION'] });
    const { cookie } = await h.viewer();
    const ok = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR' });
    expect(ok.statusCode, ok.body).toBe(200);

    await h.policy({ environments: ['HOMOLOGATION'] });
    const before = h.mock.calls.length;
    const res = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    const schema = await h.call(cookie, { method: 'GET', url: '/api/schema' });
    expect(schema.statusCode).toBe(403);
    expect(h.mock.calls.length).toBe(before);
  });
});

interface SchemaTable {
  name: string;
  columns: Array<{ name: string }>;
}
const catalogOf = async (h: Harness, cookie: string) => {
  const res = await h.call(cookie, { method: 'GET', url: '/api/schema' });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { connectionId: string; catalog: { tables: SchemaTable[] } };
  return { body, tables: body.catalog.tables, raw: res.body };
};
const tableOf = (tables: SchemaTable[], name: string) => tables.find((t) => t.name === name);

describe('catalog filtering by read policy', () => {
  it('serves the full catalog when no rule denies anything', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    const { body, tables } = await catalogOf(h, cookie);
    expect(body.connectionId).toBe('env-default');
    expect(Object.keys(body.catalog).sort()).toEqual(
      expect.arrayContaining(['fetchedAt', 'source', 'tables']),
    );
    const full = await h.app.services.metadata.get('env-default');
    expect(tables).toEqual(JSON.parse(JSON.stringify(full.tables)));
    expect(tableOf(tables, 'TGFPAR')!.columns.map((c) => c.name)).toContain('EMAIL');
  });

  it('omits a table denied by an entity rule', async () => {
    const h = await setup();
    await h.policy({ entities: ['TSICID'] });
    const { cookie } = await h.viewer();
    const { tables, raw } = await catalogOf(h, cookie);
    expect(tableOf(tables, 'TSICID')).toBeUndefined();
    expect(raw).not.toContain('TSICID');
    expect(tableOf(tables, 'TGFPAR')).toBeDefined();
    // Consistent with the read path.
    expect((await query(h, cookie, { sql: 'SELECT CODCID FROM TSICID' })).statusCode).toBe(403);
  });

  it('omits a column denied by a column rule and keeps the rest of the table', async () => {
    const h = await setup();
    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    const { cookie } = await h.viewer();
    const { tables } = await catalogOf(h, cookie);
    const par = tableOf(tables, 'TGFPAR')!;
    const names = par.columns.map((c) => c.name);
    expect(names).not.toContain('EMAIL');
    expect(names).toEqual(expect.arrayContaining(['CODPARC', 'NOMEPARC']));
    // A bare column pattern hides only that column, on the tables that have it.
    const full = await h.app.services.metadata.get('env-default');
    const fullPar = full.tables.find((t) => t.name === 'TGFPAR')!;
    expect(names).toHaveLength(fullPar.columns.length - 1);
  });

  it('reflects a policy change at once, despite the memoized catalog', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    const columnsOf = async () =>
      tableOf((await catalogOf(h, cookie)).tables, 'TGFPAR')!.columns.map((c) => c.name);
    // An unrelated deny makes the filter run (and memoize) instead of short-circuiting.
    await h.policy({ entities: ['TSICID'] });
    expect(await columnsOf()).toContain('EMAIL');
    expect(await columnsOf()).toContain('EMAIL');

    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    expect(await columnsOf()).not.toContain('EMAIL');

    const { policies } = h.app.services;
    const rule = (await policies.list()).find((r) => r.columns.includes('TGFPAR.EMAIL'))!;
    await policies.update(rule.id, { enabled: false });
    expect(await columnsOf()).toContain('EMAIL');
    await policies.update(rule.id, { enabled: true });
    expect(await columnsOf()).not.toContain('EMAIL');
    await policies.delete(rule.id);
    expect(await columnsOf()).toContain('EMAIL');
  });

  it('applies rules to an administrator too (no bypass)', async () => {
    const h = await setup();
    await h.policy({ entities: ['TSICID'] });
    await h.policy({ columns: ['EMAIL'] });
    const admin = await h.login();
    const { tables } = await catalogOf(h, admin);
    expect(tableOf(tables, 'TSICID')).toBeUndefined();
    for (const t of tables) expect(t.columns.map((c) => c.name)).not.toContain('EMAIL');
  });

  it('scopes the filter to the subject of the rule', async () => {
    const h = await setup();
    const denied = await h.viewer();
    const other = await h.viewer();
    await h.policy({ subjectType: 'user', subjectId: denied.id, entities: ['TGF*'] });
    const mine = await catalogOf(h, denied.cookie);
    expect(mine.tables.some((t) => t.name.startsWith('TGF'))).toBe(false);
    expect(tableOf(mine.tables, 'TSICID')).toBeDefined();
    const theirs = await catalogOf(h, other.cookie);
    expect(tableOf(theirs.tables, 'TGFPAR')).toBeDefined();
  });

  it('serves no table when the policy evaluation fails (fail closed)', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    await catalogOf(h, cookie); // connection authorized and catalog cached
    const policies = h.app.services.policies;
    // The connection check passes; compiling the rules for the filter then breaks.
    policies.denyChecker = () => Promise.reject(new Error('boom'));
    const { body, tables } = await catalogOf(h, cookie);
    expect(tables).toEqual([]);
    expect(body.catalog).toMatchObject({ degraded: ['POLICY:failed'] });
    expect(h.logs.join('\n')).toContain('Catalog policy filter failed');
  });

  it('applies a group-scoped DENY to members only', async () => {
    const h = await setup();
    const member = await h.viewer();
    const outsider = await h.viewer();
    const adminId = (await h.app.services.users.findByEmail(ADMIN.email))!.id;
    const group = await h.app.services.authz.createGroup({ name: 'No cities' });
    await h.app.services.authz.setGroupMembers(group.id, [member.id], adminId);
    await h.policy({ subjectType: 'group', subjectId: group.id, entities: ['TSICID'] });

    expect(tableOf((await catalogOf(h, member.cookie)).tables, 'TSICID')).toBeUndefined();
    expect(tableOf((await catalogOf(h, outsider.cookie)).tables, 'TSICID')).toBeDefined();
  });

  it('follows a group membership change at once, despite the memoized catalog', async () => {
    const h = await setup();
    const first = await h.viewer();
    const second = await h.viewer();
    const adminId = (await h.app.services.users.findByEmail(ADMIN.email))!.id;
    const group = await h.app.services.authz.createGroup({ name: 'No cities' });
    await h.app.services.authz.setGroupMembers(group.id, [first.id], adminId);
    await h.policy({ subjectType: 'group', subjectId: group.id, entities: ['TSICID'] });
    const sees = async (cookie: string) =>
      tableOf((await catalogOf(h, cookie)).tables, 'TSICID') !== undefined;

    // Twice each, so the second answer comes from the memo.
    expect(await sees(first.cookie)).toBe(false);
    expect(await sees(first.cookie)).toBe(false);
    expect(await sees(second.cookie)).toBe(true);
    expect(await sees(second.cookie)).toBe(true);

    await h.app.services.authz.setGroupMembers(group.id, [second.id], adminId);
    expect(await sees(first.cookie)).toBe(true);
    expect(await sees(second.cookie)).toBe(false);
  });

  it('applies an environment-scoped DENY in that environment only', async () => {
    const h = await setup({ SANKHYA_ENVIRONMENT: 'HOMOLOGATION' });
    const sandbox = await h.app.services.connections.create({
      name: 'Sandbox',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'oracle',
      secrets: { ...MOCK_CREDENTIALS },
    });
    await h.policy({ environments: ['HOMOLOGATION'], entities: ['TSICID'] });
    await h.policy({ environments: ['SANDBOX'], entities: ['TGFPRO'] });
    const { cookie } = await h.viewer();

    const homolog = (await catalogOf(h, cookie)).tables;
    expect(tableOf(homolog, 'TSICID')).toBeUndefined();
    expect(tableOf(homolog, 'TGFPRO')).toBeDefined();

    const res = await h.call(cookie, {
      method: 'GET',
      url: `/api/schema?connectionId=${sandbox.id}`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const sand = (res.json() as { catalog: { tables: SchemaTable[] } }).catalog.tables;
    expect(tableOf(sand, 'TGFPRO')).toBeUndefined();
    expect(tableOf(sand, 'TSICID')).toBeDefined();
  });

  it('applies a connection-scoped DENY on that connection only', async () => {
    const h = await setup();
    const conn = await h.app.services.connections.create({
      name: 'Demo',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'oracle',
      secrets: { ...MOCK_CREDENTIALS },
    });
    await h.policy({ connectionIds: [conn.id], entities: ['TSICID'] });
    const { cookie } = await h.viewer();

    const res = await h.call(cookie, { method: 'GET', url: `/api/schema?connectionId=${conn.id}` });
    expect(res.statusCode, res.body).toBe(200);
    const scoped = (res.json() as { catalog: { tables: SchemaTable[] } }).catalog.tables;
    expect(tableOf(scoped, 'TSICID')).toBeUndefined();
    expect(tableOf(scoped, 'TGFPAR')).toBeDefined();
    expect(tableOf((await catalogOf(h, cookie)).tables, 'TSICID')).toBeDefined();
  });
});

describe('policies at startup', () => {
  it('logs a corrupt stored rule at boot, keeps running and denies reads', async () => {
    const h = await setup({}, async (database) => {
      await database.db.execute(sql`
        insert into policies (name, effect, subject_type, actions, environments, enabled)
        values ('corrupt', 'DENY', 'everyone', '{}', '{MOON}', true)`);
    });
    await h.app.ready();
    expect(h.logs.join('\n')).toContain('Invalid enabled policy rules');
    const { cookie } = await h.viewer();
    const res = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR' });
    expect(res.statusCode).toBe(403);
    const status = await h.call(cookie, { method: 'GET', url: '/api/status' });
    expect(status.statusCode).toBe(200);
  });

  it('does not crash when the rules cannot be loaded at boot', async () => {
    const h = await setup();
    h.app.services.policies.load = () => Promise.reject(new Error('database unavailable'));
    await expect(h.app.ready()).resolves.toBeDefined();
    expect(h.logs.join('\n')).toContain('Policies could not be loaded at startup');
  });
});

describe('scratch routes', () => {
  it('requires a session', async () => {
    const h = await setup();
    expect(codeOf(await exec(h, '', 'SELECT 1'))).toBe('AUTH_REQUIRED');
    const res = await h.call(null, { method: 'GET', url: '/api/scratch/tables' });
    expect(res.statusCode).toBe(401);
  });

  it('lets a VIEWER create, fill and read a scratch table', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_x (a int)')).statusCode).toBe(200);
    expect((await exec(h, cookie, 'INSERT INTO tmp_x VALUES (1), (2)')).statusCode).toBe(200);
    const sel = await exec(h, cookie, 'SELECT a FROM tmp_x ORDER BY a');
    expect(sel.statusCode, sel.body).toBe(200);
    expect(sel.json()).toMatchObject({ command: 'SELECT', columns: ['a'], rowCount: 2 });
    expect(await tables(h, cookie)).toEqual([{ name: 'tmp_x', rows: 2 }]);
    // Workspaces are per user.
    const other = await h.viewer();
    expect(await tables(h, other.cookie)).toEqual([]);
  });

  it('refuses CREATE TABLE tmp_x to a user without TEMP.CREATE and audits it', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(['QUERY.SELECT', 'TEMP.WRITE', 'TEMP.DROP']);
    const res = await exec(h, cookie, 'CREATE TABLE tmp_x (a int)');
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(await tables(h, cookie)).toEqual([]);
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=scratch.denied' });
    expect(audit.json().items[0]).toMatchObject({
      status: 'denied',
      operation: 'CREATE TABLE',
      resource: 'tmp_x',
      errorCode: 'FORBIDDEN',
    });
  });

  it('enforces policy rules on scratch statements', async () => {
    const h = await setup();
    await h.policy({ actions: ['TEMP.CREATE'] });
    const { cookie } = await h.viewer();
    const res = await exec(h, cookie, 'CREATE TABLE tmp_x (a int)');
    expect(res.statusCode).toBe(403);
    expect(await tables(h, cookie)).toEqual([]);
  });

  it('evaluates scratch reads with their columns', async () => {
    const h = await setup();
    await h.policy({ columns: ['tmp_p.email'] });
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_p (id int, email text)')).statusCode).toBe(200);
    expect((await exec(h, cookie, "INSERT INTO tmp_p VALUES (1, 'a@x')")).statusCode).toBe(200);
    expect((await exec(h, cookie, 'CREATE TABLE tmp_q (email text)')).statusCode).toBe(200);
    for (const sqlText of ['SELECT id FROM tmp_p', 'SELECT count(*) FROM tmp_p']) {
      const res = await exec(h, cookie, sqlText);
      expect(res.statusCode, `${sqlText} ${res.body}`).toBe(200);
    }
    for (const sqlText of [
      'SELECT email FROM tmp_p',
      'SELECT * FROM tmp_p',
      'SELECT p.id FROM tmp_p p WHERE p.email IS NOT NULL',
      'SELECT row_to_json(p) FROM tmp_p p',
      'SELECT tmp_p FROM tmp_p',
      'SELECT id FROM tmp_p JOIN tmp_q USING (email)',
      'SELECT id FROM tmp_p NATURAL JOIN tmp_q',
    ]) {
      const res = await exec(h, cookie, sqlText);
      expect(res.statusCode, sqlText).toBe(403);
      expect(codeOf(res), sqlText).toBe('FORBIDDEN');
    }
  });

  it("caps scratch results at the policy's maxReadRows", async () => {
    const h = await setup();
    await h.policy({ effect: 'ALLOW', limits: { maxReadRows: 3 } });
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_n (a int)')).statusCode).toBe(200);
    const ins = await exec(h, cookie, 'INSERT INTO tmp_n SELECT g FROM generate_series(1, 10) g');
    expect(ins.statusCode, ins.body).toBe(200);
    const res = await exec(h, cookie, 'SELECT a FROM tmp_n ORDER BY a');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ rowCount: 10, truncated: true });
    expect(res.json().rows).toHaveLength(3);
  });

  it('does not cap scratch writes at the default write limit', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_n (a int)')).statusCode).toBe(200);
    const ins = await exec(h, cookie, 'INSERT INTO tmp_n SELECT g FROM generate_series(1, 1500) g');
    expect(ins.statusCode, ins.body).toBe(200);
    const upd = await exec(h, cookie, 'UPDATE tmp_n SET a = a + 1 WHERE a > 0');
    expect(upd.statusCode, upd.body).toBe(200);
    expect(upd.json().rowCount).toBe(1500);
  });

  it("refuses a scratch write over a rule's maxWriteRows and rolls it back", async () => {
    const h = await setup();
    await h.policy({ effect: 'ALLOW', actions: ['TEMP.WRITE'], limits: { maxWriteRows: 10 } });
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_n (a int)')).statusCode).toBe(200);
    const ok = await exec(h, cookie, 'INSERT INTO tmp_n SELECT g FROM generate_series(1, 10) g');
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await exec(h, cookie, 'INSERT INTO tmp_n VALUES (11)')).statusCode).toBe(200);
    const big = await exec(h, cookie, 'UPDATE tmp_n SET a = 0 WHERE a > 0');
    expect(big.statusCode).toBe(400);
    expect(codeOf(big)).toBe('QUERY_LIMIT_EXCEEDED');
    // Rolled back: no row was zeroed.
    const zeroed = await exec(h, cookie, 'SELECT a FROM tmp_n WHERE a = 0');
    expect(zeroed.json().rowCount).toBe(0);
  });

  it('evaluates the read policy before listing scratch tables', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    expect((await exec(h, cookie, 'CREATE TABLE tmp_x (a int)')).statusCode).toBe(200);
    await h.policy({ environments: ['SANDBOX'] });
    const res = await h.call(cookie, { method: 'GET', url: '/api/scratch/tables' });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=scratch.denied' });
    expect(audit.json().items[0]).toMatchObject({ operation: 'TABLES', errorCode: 'FORBIDDEN' });
  });

  it('validates scratch SQL before authorizing it', async () => {
    const h = await setup();
    const nobody = await h.userWith([]);
    const res = await exec(h, nobody.cookie, 'CREATE TABLE erp_x (a int)');
    expect(res.statusCode).toBe(400);
  });
});

describe('materialization route', () => {
  const READ = { sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR', into: 'tmp_par' };

  it('materializes a Sankhya read into a scratch table', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, READ);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ table: 'tmp_par', truncated: false });
    const rows = res.json().rows as number;
    expect(rows).toBeGreaterThan(0);
    expect(await tables(h, cookie)).toEqual([{ name: 'tmp_par', rows }]);
  });

  it('requires both QUERY.SELECT and TEMP.MATERIALIZE', async () => {
    const h = await setup();
    for (const permissions of [
      ['TEMP.MATERIALIZE', 'TEMP.CREATE', 'TEMP.WRITE'],
      ['QUERY.SELECT', 'TEMP.CREATE', 'TEMP.WRITE'],
    ] as Permission[][]) {
      const { cookie, id } = await h.userWith(permissions);
      const res = await materialize(h, cookie, READ);
      expect(res.statusCode, permissions.join()).toBe(403);
      expect(codeOf(res)).toBe('FORBIDDEN');
      // Read directly: one of these users may not list scratch tables.
      expect(await (await h.app.services.scratch.workspace(id)).tables()).toEqual([]);
    }
    expect(reads(h.mock, 'NOMEPARC')).toBe(0);
  });

  it('applies the read policy to the source and creates nothing when denied', async () => {
    const h = await setup();
    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, { sql: 'SELECT * FROM TGFPAR', into: 'tmp_par' });
    expect(res.statusCode).toBe(403);
    expect(await tables(h, cookie)).toEqual([]);
    expect(reads(h.mock, 'EMAIL')).toBe(0);
  });

  it('refuses a policy-denied TEMP.MATERIALIZE', async () => {
    const h = await setup();
    await h.policy({ actions: ['TEMP.MATERIALIZE'] });
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, READ);
    expect(res.statusCode).toBe(403);
    expect(await tables(h, cookie)).toEqual([]);
  });

  it('evaluates TEMP.MATERIALIZE against the source environment', async () => {
    const h = await setup({ SANKHYA_ENVIRONMENT: 'PRODUCTION' });
    await h.policy({ actions: ['TEMP.MATERIALIZE'], environments: ['PRODUCTION'] });
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, READ);
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(await tables(h, cookie)).toEqual([]);
    expect(reads(h.mock, 'NOMEPARC')).toBe(0);
    // The same rule does not stop a plain read of that connection.
    expect((await query(h, cookie, { sql: READ.sql })).statusCode).toBe(200);
  });

  it('evaluates TEMP.MATERIALIZE against the source entities and columns', async () => {
    const h = await setup();
    await h.policy({ actions: ['TEMP.MATERIALIZE'], entities: ['TGF*'] });
    await h.policy({ actions: ['TEMP.MATERIALIZE'], columns: ['TSICID.NOMECID'] });
    const { cookie } = await h.viewer();
    for (const sqlText of [READ.sql, 'SELECT * FROM TSICID']) {
      const res = await materialize(h, cookie, { sql: sqlText, into: 'tmp_src' });
      expect(res.statusCode, sqlText).toBe(403);
      expect(codeOf(res), sqlText).toBe('FORBIDDEN');
    }
    expect(await tables(h, cookie)).toEqual([]);
    const ok = await materialize(h, cookie, { sql: 'SELECT CODCID FROM TSICID', into: 'tmp_src' });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("caps the copy at a scratch-side TEMP.MATERIALIZE rule's maxReadRows", async () => {
    const h = await setup();
    await h.policy({
      effect: 'ALLOW',
      actions: ['TEMP.MATERIALIZE'],
      environments: ['SANDBOX'],
      limits: { maxReadRows: 4 },
    });
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, READ);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ table: 'tmp_par', rows: 4, truncated: true });
  });

  it('needs replace: true to overwrite an existing table', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    expect((await materialize(h, cookie, READ)).statusCode).toBe(200);
    const before = reads(h.mock, 'NOMEPARC');
    const again = await materialize(h, cookie, {
      sql: 'SELECT CODPARC FROM TGFPAR',
      into: 'tmp_par',
    });
    expect(again.statusCode).toBe(409);
    expect(codeOf(again)).toBe('CONFLICT');
    expect(reads(h.mock, 'NOMEPARC')).toBe(before);
    const replaced = await materialize(h, cookie, {
      sql: 'SELECT CODPARC FROM TGFPAR',
      into: 'tmp_par',
      replace: true,
    });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const sel = await exec(h, cookie, 'SELECT * FROM tmp_par');
    expect(sel.json().columns).toEqual(['codparc']);
  });

  it('caps the copied rows at MATERIALIZE_MAX_ROWS', async () => {
    const h = await setup({ MATERIALIZE_MAX_ROWS: '7' });
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, READ);
    expect(res.json()).toMatchObject({ table: 'tmp_par', rows: 7, truncated: true });
  });

  it('applies the connection authorization to the source', async () => {
    const h = await setup();
    const { cookie } = await h.viewer();
    const res = await materialize(h, cookie, { ...READ, connectionId: UNKNOWN_CONNECTION });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
  });
});
