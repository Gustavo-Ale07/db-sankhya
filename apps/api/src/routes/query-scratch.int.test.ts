import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import type { PolicyInput } from '../services/policy';

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
  SCRATCH_MAX_WORKSPACES: '4',
};

const ALL: Permission[] = [
  'QUERY.SELECT',
  'TEMP.CREATE',
  'TEMP.WRITE',
  'TEMP.DROP',
  'TEMP.MATERIALIZE',
];

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  mock: MockSankhya;
  userWith(permissions: Permission[]): Promise<string>;
  call(
    cookie: string,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  policy(input: Partial<PolicyInput>): Promise<void>;
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
    sankhya: { mockGateway: () => Promise.resolve({ ...mock, close: async () => undefined }) },
  });
  const admin = await app.services.users.create({
    email: ADMIN.email,
    name: 'Admin',
    password: ADMIN.password,
    roles: config.bootstrapAdmin.roles,
  });
  const call: Harness['call'] = (cookie, opts) =>
    app.inject({
      ...opts,
      headers: { origin: ORIGIN, cookie: `${config.session.cookieName}=${cookie}` },
    });
  let n = 0;
  const userWith = async (permissions: Permission[]) => {
    const key = `CUSTOM_${++n}`;
    await app.services.authz.createRole({ key, name: key, permissions }, admin.id);
    const email = `user${n}@example.com`;
    await app.services.users.create({ email, name: 'User', password: PASSWORD, roles: [key] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.cookies.find((x) => x.name === config.session.cookieName)!.value;
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
  const h: Harness = { app, database, mock, userWith, call, policy };
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

const query = (h: Harness, cookie: string, payload: Record<string, unknown>) =>
  h.call(cookie, { method: 'POST', url: '/api/query', payload });
const exec = async (h: Harness, cookie: string, sql: string) => {
  const res = await h.call(cookie, { method: 'POST', url: '/api/scratch/exec', payload: { sql } });
  expect(res.statusCode, res.body).toBe(200);
};
const tables = async (h: Harness, cookie: string) => {
  const res = await h.call(cookie, { method: 'GET', url: '/api/scratch/tables' });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { tables: Array<{ name: string }> }).tables.map((t) => t.name);
};
const executeQueries = (mock: MockSankhya, needle = '') =>
  mock.calls.filter(
    (c) => c.serviceName === 'DbExplorerSP.executeQuery' && JSON.stringify(c).includes(needle),
  );
const writes = (mock: MockSankhya) =>
  mock.calls.filter((c) => c.serviceName !== 'DbExplorerSP.executeQuery');
const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

/** A user with every scratch permission and a tmp_ids table holding the ids 1, 2 and 3. */
async function withIds(h: Harness, permissions = ALL) {
  const cookie = await h.userWith(permissions);
  await exec(h, cookie, 'CREATE TABLE tmp_ids (id int)');
  await exec(h, cookie, 'INSERT INTO tmp_ids VALUES (1), (2), (3)');
  return cookie;
}

const HYBRID =
  'WITH p AS (SELECT CODPARC, NOMEPARC FROM TGFPAR) ' +
  'SELECT t.id, p.nomeparc FROM tmp_ids t JOIN p ON p.codparc = t.id ORDER BY t.id';

describe('POST /api/query on scratch tables (A1)', () => {
  it('runs a read of tmp_ tables in the caller workspace, without the gateway', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    const before = h.mock.calls.length;
    const res = await query(h, cookie, { sql: 'SELECT id FROM tmp_ids WHERE id > 1 ORDER BY id' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      type: 'result',
      kind: 'SELECT',
      source: 'scratch',
      connectionId: 'env-default',
      resource: 'tmp_ids',
      rows: [[2], [3]],
      rowCount: 2,
      apiCalls: 0,
    });
    expect(h.mock.calls.length).toBe(before);
  });

  it('keeps Sankhya reads on the Sankhya path, marked as such', async () => {
    const h = await setup();
    const cookie = await h.userWith(['QUERY.SELECT']);
    const res = await query(h, cookie, { sql: 'SELECT CODPARC FROM TGFPAR WHERE CODPARC = 1' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ source: 'sankhya', rows: [[1]] });
    // An unknown table that is not tmp_ is still refused by the Sankhya catalog.
    const unknown = await query(h, cookie, { sql: 'SELECT X FROM NOPE' });
    expect(codeOf(unknown)).toBe('RESOURCE_NOT_FOUND');
  });

  it("caps a scratch read at the policy's maxReadRows and applies scratch column rules", async () => {
    const h = await setup();
    const cookie = await withIds(h);
    await h.policy({
      effect: 'ALLOW',
      actions: ['QUERY.SELECT'],
      environments: ['SANDBOX'],
      limits: { maxReadRows: 2 },
    });
    const capped = await query(h, cookie, { sql: 'SELECT id FROM tmp_ids ORDER BY id' });
    expect(capped.statusCode, capped.body).toBe(200);
    expect(capped.json()).toMatchObject({ rows: [[1], [2]], truncated: true });

    await h.policy({ environments: ['SANDBOX'], columns: ['tmp_ids.id'] });
    const denied = await query(h, cookie, { sql: 'SELECT id FROM tmp_ids' });
    expect(denied.statusCode).toBe(403);
    expect(codeOf(denied)).toBe('FORBIDDEN');
  });

  it("never reads another user's tmp_ tables", async () => {
    const h = await setup();
    await withIds(h);
    const other = await h.userWith(ALL);
    const res = await query(h, other, { sql: 'SELECT id FROM tmp_ids' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).not.toContain('"rows"');
  });
});

describe('POST /api/query hybrid reads (A2)', () => {
  it('copies the Sankhya part once into an ephemeral table, joins it and drops it', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    const res = await query(h, cookie, { sql: HYBRID });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      source: 'hybrid',
      connectionId: 'env-default',
      columns: [{ name: 'id' }, { name: 'nomeparc' }],
      rowCount: 3,
      apiCalls: 1,
      hybrid: { parts: [{ tables: ['TGFPAR'], rows: 60, truncated: false }] },
    });
    expect(body.rows.map((r: unknown[]) => r[0])).toEqual([1, 2, 3]);
    // The part ran exactly once, as written; no write reached the gateway.
    expect(executeQueries(h.mock, 'FROM TGFPAR')).toHaveLength(1);
    expect(executeQueries(h.mock, 'SELECT CODPARC, NOMEPARC FROM TGFPAR')).toHaveLength(1);
    expect(writes(h.mock)).toEqual([]);
    expect(await tables(h, cookie)).toEqual(['tmp_ids']);
  });

  it('caps each part at MATERIALIZE_MAX_ROWS and reports the cut', async () => {
    const h = await setup({ MATERIALIZE_MAX_ROWS: '2' });
    const cookie = await withIds(h);
    const res = await query(h, cookie, { sql: HYBRID });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      rowCount: 2,
      hybrid: { parts: [{ tables: ['TGFPAR'], rows: 2, truncated: true }] },
      messages: ['Sankhya part (TGFPAR) cut at 2 rows.'],
    });
  });

  it('applies a column DENY to the Sankhya part before the gateway', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    await h.policy({ columns: ['TGFPAR.EMAIL'] });
    const res = await query(h, cookie, {
      sql: 'SELECT t.id FROM tmp_ids t WHERE t.id IN (SELECT CODPARC FROM TGFPAR WHERE EMAIL IS NOT NULL)',
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(res.body).not.toContain('test rule');
    expect(executeQueries(h.mock, 'EMAIL')).toHaveLength(0);
    expect(await tables(h, cookie)).toEqual(['tmp_ids']);
  });

  it('requires TEMP.MATERIALIZE, before any gateway call', async () => {
    const h = await setup();
    const cookie = await withIds(h, ['QUERY.SELECT', 'TEMP.CREATE', 'TEMP.WRITE']);
    const before = h.mock.calls.length;
    const res = await query(h, cookie, { sql: HYBRID });
    expect(res.statusCode).toBe(403);
    expect(h.mock.calls.length).toBe(before);
  });

  it('refuses a statement it cannot split, pointing to materialize', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    const before = h.mock.calls.length;
    const res = await query(h, cookie, {
      sql: 'SELECT t.id FROM tmp_ids t JOIN TGFPAR p ON p.CODPARC = t.id',
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('SQL_UNSUPPORTED');
    expect(res.json().error.message).toMatch(/materialize/);
    expect(h.mock.calls.length).toBe(before);
  });

  it('drops the ephemeral tables when a later part fails', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    // The first part is copied; the second is denied when its turn comes.
    await h.policy({ entities: ['TSICID'] });
    const res = await query(h, cookie, {
      sql:
        'SELECT t.id FROM tmp_ids t WHERE t.id IN (SELECT CODPARC FROM TGFPAR) ' +
        'AND t.id IN (SELECT CODCID FROM TSICID)',
    });
    expect(res.statusCode).toBe(403);
    expect(executeQueries(h.mock, 'FROM TGFPAR')).toHaveLength(1);
    expect(await tables(h, cookie)).toEqual(['tmp_ids']);
  });

  it('drops the ephemeral tables when the final read fails', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    const res = await query(h, cookie, {
      sql: 'WITH p AS (SELECT CODPARC FROM TGFPAR) SELECT t.nope FROM tmp_ids t JOIN p ON p.codparc = t.id',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await tables(h, cookie)).toEqual(['tmp_ids']);
  });

  it('drops the ephemeral tables when the read is cancelled', async () => {
    const h = await setup();
    const cookie = await withIds(h);
    h.mock.inject({ type: 'delay', ms: 1500 }, { sqlIncludes: 'FROM TGFPAR' });
    const executionId = 'hybrid-cancel-1';
    const pending = query(h, cookie, { sql: HYBRID, executionId });
    await new Promise((r) => setTimeout(r, 300));
    const cancel = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/cancel',
      payload: { executionId },
    });
    expect(cancel.json()).toEqual({ cancelled: true });
    const res = await pending;
    expect(codeOf(res)).toBe('QUERY_CANCELLED');
    expect(await tables(h, cookie)).toEqual(['tmp_ids']);
  });
});
