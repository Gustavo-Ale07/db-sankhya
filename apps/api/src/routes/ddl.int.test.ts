import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase, rolePermissions, roles } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from '../app';
import { loadConfig, secretValues } from '../config';
import { loggerOptions } from '../logger';
import type { Catalog, CatalogTable } from '../services/metadata';
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
};

const CREATE = 'CREATE TABLE AD_NOVA (ID INT PRIMARY KEY, NOME VARCHAR(40) NOT NULL)';

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  mock: MockSankhya;
  logs: string[];
  login(email?: string, password?: string): Promise<string>;
  userWith(permissions: Permission[]): Promise<{ cookie: string; id: string }>;
  call(
    cookie: string | null,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
  policy(input: Partial<PolicyInput>): Promise<void>;
  /** A user holding DDL.CUSTOM.GENERATE, with an ALLOW rule for it. */
  generator(): Promise<string>;
  ddl(cookie: string | null, payload: Record<string, unknown>): ReturnType<Harness['call']>;
}

const open: Harness[] = [];

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
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
  await app.services.users.create({
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
  const userWith = async (permissions: Permission[]) => {
    const key = `CUSTOM_${++n}`;
    // Seeded directly: no administrator may grant DDL.CUSTOM.GENERATE (it is not theirs to give).
    const [role] = await database.db
      .insert(roles)
      .values({ key, name: key, system: false })
      .returning({ id: roles.id });
    if (permissions.length > 0)
      await database.db
        .insert(rolePermissions)
        .values(permissions.map((permission) => ({ roleId: role!.id, permission })));
    const email = `user${++n}@example.com`;
    const user = await app.services.users.create({
      email,
      name: 'User',
      password: PASSWORD,
      roles: [key],
    });
    return { cookie: await login(email, PASSWORD), id: user.id };
  };
  const policy = async (input: Partial<PolicyInput>) => {
    await app.services.policies.create({
      name: 'test rule',
      effect: 'DENY',
      subjectType: 'everyone',
      subjectId: null,
      environments: [],
      connectionIds: [],
      actions: ['DDL.CUSTOM.GENERATE'],
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
    call,
    policy,
    generator: async () => {
      await policy({ effect: 'ALLOW' });
      return (await userWith(['DDL.CUSTOM.GENERATE'])).cookie;
    },
    ddl: (cookie, payload) => call(cookie, { method: 'POST', url: '/api/ddl/artifact', payload }),
  };
  open.push(h);
  return h;
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
    await h.mock.close();
  }
});

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

const auditOf = async (h: Harness, action: string) => {
  const res = await h.call(await h.login(), { method: 'GET', url: `/api/audit?action=${action}` });
  return res.json() as { total: number; items: Array<Record<string, unknown>> };
};

/** An existing custom table, as its own dictionary rows describe it (no sizes or nullability). */
const AD_EXEMPLO: CatalogTable = {
  name: 'AD_EXEMPLO',
  columns: [
    { name: 'ID', type: 'integer', pk: true },
    { name: 'NOME', type: 'string', pk: false },
    { name: 'OBS', type: 'string', pk: false },
  ],
  foreignKeys: [],
};
const existing = (h: Harness) =>
  vi
    .spyOn(h.app.services.metadata, 'table')
    .mockImplementation((_connectionId, name) =>
      Promise.resolve(name.toUpperCase() === 'AD_EXEMPLO' ? AD_EXEMPLO : undefined),
    );

describe('POST /api/ddl/artifact', () => {
  it('requires a session and DDL.CUSTOM.GENERATE, and audits the denial', async () => {
    const h = await setup();
    expect((await h.ddl(null, { sql: CREATE })).statusCode).toBe(401);
    const viewer = (await h.userWith(['QUERY.SELECT'])).cookie;
    const res = await h.ddl(viewer, { sql: CREATE });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect((await auditOf(h, 'ddl.denied')).total).toBe(1);
  });

  it('is not granted by the ADMIN role, even with an allow-everything rule', async () => {
    const h = await setup();
    await h.policy({ effect: 'ALLOW' });
    const res = await h.ddl(await h.login(), { sql: CREATE });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
  });

  it('rejects a cross-origin request', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/ddl/artifact',
      headers: { origin: 'https://evil.example.com' },
      payload: { sql: CREATE },
    });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('CSRF_REJECTED');
  });

  it('is default-deny: the permission alone is not enough without an ALLOW rule', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(['DDL.CUSTOM.GENERATE']);
    const res = await h.ddl(cookie, { sql: CREATE });
    expect(res.statusCode, res.body).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(res.body).not.toContain('test rule');
    expect((await auditOf(h, 'ddl.denied')).total).toBe(1);
  });

  it('a DENY rule on the table wins over an ALLOW', async () => {
    const h = await setup();
    const cookie = await h.generator();
    await h.policy({ entities: ['AD_NOVA'] });
    expect((await h.ddl(cookie, { sql: CREATE })).statusCode).toBe(403);
  });

  it('generates both artifacts for a new custom table and executes nothing', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.ddl(cookie, { sql: CREATE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.json();
    expect(body).toMatchObject({ table: 'AD_NOVA', severity: 'SAFE' });
    expect(body.changes[0].kind).toBe('CREATE_TABLE');
    const kinds = body.artifacts.map((a: { kind: string }) => a.kind).sort();
    expect(kinds).toEqual(['autoddl', 'dbscript']);
    const autoddl = body.artifacts.find((a: { kind: string }) => a.kind === 'autoddl');
    expect(autoddl.filename).toBe('AD_NOVA.xml');
    expect(autoddl.contentType).toContain('xml');
    expect(autoddl.content).toContain('AD_NOVA');
    const script = body.artifacts.find((a: { kind: string }) => a.kind === 'dbscript');
    expect(script.filename).toBe('V1.xml');
    expect(script.content).toContain('<scripts version="1">');
    // Only dictionary reads reached the gateway; the DDL itself was never sent.
    expect(JSON.stringify(h.mock.calls)).not.toContain('CREATE TABLE');
    const audit = await auditOf(h, 'ddl.generate');
    expect(audit.total).toBe(1);
    expect(audit.items[0]).toMatchObject({ status: 'success', resource: 'AD_NOVA' });
  });

  it('honours format and version', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.ddl(cookie, { sql: CREATE, format: 'dbscript', version: 7 });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().artifacts).toHaveLength(1);
    expect(res.json().artifacts[0].filename).toBe('V7.xml');
  });

  it('refuses a native table as SQL_UNSUPPORTED and audits it', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.ddl(cookie, { sql: 'CREATE TABLE TGFPAR (ID INT PRIMARY KEY)' });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('SQL_UNSUPPORTED');
    expect((await auditOf(h, 'ddl.denied')).total).toBe(1);
  });

  it('honours configured custom prefixes', async () => {
    const h = await setup({ CUSTOM_TABLE_PREFIXES: 'XY_' });
    const cookie = await h.generator();
    expect((await h.ddl(cookie, { sql: CREATE })).statusCode).toBe(400);
    const ok = await h.ddl(cookie, {
      sql: 'CREATE TABLE XY_EXEMPLO (ID INT PRIMARY KEY)',
    });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('fails closed on unparseable and non-CREATE input', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const bad = await h.ddl(cookie, { sql: 'CREATE TABLE AD_X (' });
    expect(bad.statusCode).toBe(400);
    expect(['SQL_PARSE_ERROR', 'SQL_UNSUPPORTED']).toContain(codeOf(bad));
    for (const sql of ['DROP TABLE AD_EXEMPLO', 'SELECT 1', `${CREATE}; DROP TABLE TGFPAR`]) {
      const res = await h.ddl(cookie, { sql });
      expect(res.statusCode, sql).toBe(400);
    }
    expect((await h.ddl(cookie, {})).statusCode).toBe(400);
    expect((await h.ddl(cookie, { sql: CREATE, extra: 1 })).statusCode).toBe(400);
  });

  it('requires the typed confirmation for a DESTRUCTIVE diff against the catalog', async () => {
    const h = await setup();
    const cookie = await h.generator();
    existing(h);
    // NOME and OBS exist; the desired table drops OBS.
    const sql = 'CREATE TABLE AD_EXEMPLO (ID INT PRIMARY KEY, NOME VARCHAR(40))';
    const first = await h.ddl(cookie, { sql });
    expect(first.statusCode, first.body).toBe(428);
    expect(codeOf(first)).toBe('CONFIRMATION_REQUIRED');
    expect((await auditOf(h, 'ddl.denied')).total).toBe(0);
    for (const confirm of ['DESTRUCTIVE ad_exemplo', 'destructive AD_EXEMPLO', 'yes', '']) {
      const wrong = await h.ddl(cookie, { sql, confirm });
      expect(wrong.statusCode, confirm).toBe(400);
      expect(codeOf(wrong), confirm).toBe('CONFIRMATION_INVALID');
    }
    // A wrong confirmation is refused and audited.
    expect((await auditOf(h, 'ddl.denied')).items[0]).toMatchObject({
      errorCode: 'CONFIRMATION_INVALID',
    });
    const ok = await h.ddl(cookie, { sql, confirm: 'DESTRUCTIVE AD_EXEMPLO' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().severity).toBe('DESTRUCTIVE');
    expect(ok.json().changes.map((c: { kind: string }) => c.kind)).toContain('DROP_FIELD');
    expect(ok.json().warnings.length).toBeGreaterThan(0);
  });

  it('treats unverifiable properties of an existing field as destructive', async () => {
    const h = await setup();
    const cookie = await h.generator();
    existing(h);
    const same =
      'CREATE TABLE AD_EXEMPLO (ID INT PRIMARY KEY, NOME VARCHAR(5), OBS VARCHAR(10), EXTRA VARCHAR(5))';
    const res = await h.ddl(cookie, { sql: same });
    expect(res.statusCode, res.body).toBe(428);
    expect(res.body).toContain('Cannot verify');
    // Asking for the confirmation is a step of the flow, not a denial.
    expect((await auditOf(h, 'ddl.denied')).total).toBe(0);
    const ok = await h.ddl(cookie, { sql: same, confirm: 'DESTRUCTIVE AD_EXEMPLO' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().severity).toBe('DESTRUCTIVE');
  });

  it('requires confirmation when an existing text field becomes a CLOB', async () => {
    const h = await setup();
    const cookie = await h.generator();
    existing(h);
    const sql = 'CREATE TABLE AD_EXEMPLO (ID INT PRIMARY KEY, NOME TEXT, OBS VARCHAR(10))';
    const res = await h.ddl(cookie, { sql });
    expect(res.statusCode, res.body).toBe(428);
  });

  it('checks the permission before parsing the body', async () => {
    const h = await setup();
    const { cookie } = await h.userWith(['QUERY.SELECT']);
    const res = await h.ddl(cookie, { nope: 1 });
    expect(res.statusCode).toBe(403);
    expect((await auditOf(h, 'ddl.denied')).total).toBe(1);
  });

  it('diffs an existing table even when the whole-dictionary catalog was cut', async () => {
    const h = await setup();
    const cookie = await h.generator();
    existing(h);
    const whole = vi.spyOn(h.app.services.metadata, 'get').mockResolvedValue({
      tables: [{ ...AD_EXEMPLO, columns: AD_EXEMPLO.columns.slice(0, 1) }],
      fetchedAt: new Date().toISOString(),
      source: 'dictionary',
      degraded: ['TDDTAB:truncated', 'TDDCAM:truncated', 'PK:failed'],
    } satisfies Catalog);
    // NOME and OBS exist (the cut catalog lost them): keeping them is no DROP_FIELD.
    const sql =
      'CREATE TABLE AD_EXEMPLO (ID INT PRIMARY KEY, NOME VARCHAR(40), OBS VARCHAR(40), EXTRA INT)';
    const res = await h.ddl(cookie, { sql, confirm: 'DESTRUCTIVE AD_EXEMPLO' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changes.map((c: { kind: string }) => c.kind)).not.toContain('DROP_FIELD');
    expect(whole).not.toHaveBeenCalled();
  });

  it('generates nothing when the dictionary of the table cannot be read completely', async () => {
    const h = await setup();
    const cookie = await h.generator();
    h.mock.inject(
      { type: 'malformed' },
      { sqlIncludes: "FROM TDDCAM WHERE NOMETAB = 'AD_EXEMPLO'" },
    );
    // AD_EXEMPLO is in the mock dictionary; its columns cannot be read.
    const res = await h.ddl(cookie, { sql: 'CREATE TABLE AD_EXEMPLO (ID INT PRIMARY KEY)' });
    expect(res.statusCode, res.body).toBe(502);
    expect(codeOf(res)).toBe('SANKHYA_API_ERROR');
    expect(res.json()).not.toHaveProperty('artifacts');
    expect((await auditOf(h, 'ddl.denied')).items[0]).toMatchObject({
      errorCode: 'SANKHYA_API_ERROR',
    });
    expect((await auditOf(h, 'ddl.generate')).total).toBe(0);
  });

  it('reads the table on its own and treats one the dictionary lacks as new', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.ddl(cookie, { sql: CREATE });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().changes.every((c: { kind: string }) => c.kind !== 'DROP_FIELD')).toBe(true);
    const reads = h.mock.calls
      .filter((c) => c.serviceName === 'DbExplorerSP.executeQuery')
      .map((c) => String((c.requestBody as { sql?: unknown } | undefined)?.sql ?? ''));
    expect(reads.some((q) => q.includes('FROM TDDTAB WHERE NOMETAB ='))).toBe(true);
    expect(reads.some((q) => q === 'SELECT NOMETAB, DESCRTAB FROM TDDTAB')).toBe(false);
  });

  it('never echoes secrets', async () => {
    const h = await setup();
    const cookie = await h.generator();
    const res = await h.ddl(cookie, { sql: CREATE });
    for (const s of Object.values(MOCK_CREDENTIALS)) {
      expect(res.body).not.toContain(s);
      expect(h.logs.join('')).not.toContain(s);
    }
  });
});
