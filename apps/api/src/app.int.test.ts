import { Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS, createMockSankhya } from '@dbx/sankhya-client/mock';
import { buildApp } from './app';
import type { BuildAppOptions } from './app';
import { loadConfig } from './config';
import { loggerOptions } from './logger';
import { secretValues } from './config';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  BOOTSTRAP_ADMIN_ROLES: 'ADMIN,OPERATOR',
  LOG_LEVEL: 'silent',
  // The SANKHYA_* connection (mock gateway): the default connection of reads.
  SANKHYA_MODE: 'mock',
  SANKHYA_BASE_URL: 'https://gateway.example.com',
  SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  SANKHYA_CLIENT_ID: MOCK_CREDENTIALS.clientId,
  SANKHYA_CLIENT_SECRET: MOCK_CREDENTIALS.clientSecret,
  SANKHYA_X_TOKEN: MOCK_CREDENTIALS.xToken,
  SANKHYA_DIALECT: 'oracle',
};

/** Every write switch on: mutations must still fail closed. */
const WRITABLE_ENV = {
  SAFE_MODE: 'false',
  GLOBAL_WRITE_ENABLED: 'true',
  WRITE_TO_SANKHYA: 'true',
};

interface Harness {
  app: FastifyInstance;
  database: DatabaseHandle;
  logs: string[];
  login(email?: string, password?: string): Promise<string>;
  /** Creates a user with one or more role keys and returns a session cookie. */
  createUser(role: string | string[], email?: string): Promise<string>;
  call(
    cookie: string | null,
    opts: InjectOptions,
  ): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
}

const open: Harness[] = [];

async function setup(
  env: Record<string, string> = {},
  extra: Partial<BuildAppOptions> = {},
): Promise<Harness> {
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
  const app = await buildApp({
    config,
    database,
    logger: { ...(loggerOptions('trace', secretValues(config)) as object), stream },
    ...extra,
  });
  // Most tests act as an admin (BOOTSTRAP_ADMIN_ROLES) who already replaced the one-time password.
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
    const c = res.cookies.find((x) => x.name === config.session.cookieName);
    expect(c?.httpOnly).toBe(true);
    return c!.value;
  };

  let n = 0;
  const createUser = async (role: string | string[], email?: string) => {
    const roles = typeof role === 'string' ? [role] : role;
    const address = email ?? `user${++n}-${roles.join('-').toLowerCase()}@example.com`;
    await app.services.users.create({
      email: address,
      name: roles[0] ?? 'Sem papel',
      password: PASSWORD,
      roles,
    });
    return login(address, PASSWORD);
  };

  const h = { app, database, logs, login, createUser, call };
  open.push(h);
  return h;
}

afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

const READ = 'SELECT CODPARC FROM TGFPAR';

const query = (h: Harness, cookie: string, sql: string) =>
  h.call(cookie, { method: 'POST', url: '/api/query', payload: { sql } });

const codeOf = (res: { json(): unknown }) =>
  (res.json() as { error?: { code: string } }).error?.code;

describe('health and meta', () => {
  it('serves liveness, readiness and public meta without auth', async () => {
    const h = await setup();
    expect((await h.call(null, { method: 'GET', url: '/health/live' })).json()).toEqual({
      status: 'ok',
    });
    const ready = await h.call(null, { method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      status: 'ok',
      checks: { database: 'ok' },
    });
    const meta = await h.call(null, { method: 'GET', url: '/api/meta' });
    expect(meta.json()).toMatchObject({ name: 'DB-Sankhya', sankhyaMode: 'mock' });
  });

  it('sets security headers and a request id', async () => {
    const h = await setup();
    const res = await h.call(null, { method: 'GET', url: '/api/meta' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('authentication', () => {
  it('requires a session for protected routes', async () => {
    const h = await setup();
    const res = await h.call(null, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
    });
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('AUTH_REQUIRED');
  });

  it('logs in, returns the user and logs out (session revoked)', async () => {
    const h = await setup();
    const cookie = await h.login();
    const me = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(me.json()).toMatchObject({
      user: { email: ADMIN.email, roles: ['ADMIN', 'OPERATOR'] },
    });
    expect(me.json().user.permissions).toContain('ADMIN.USERS');
    expect(JSON.stringify(me.json())).not.toContain('passwordHash');
    await h.call(cookie, { method: 'POST', url: '/api/auth/logout', payload: {} });
    expect((await h.call(cookie, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
  });

  it('rejects wrong passwords with a generic error and locks after repeated failures', async () => {
    const h = await setup({ LOGIN_MAX_ATTEMPTS: '3' });
    const attempt = (password: string) =>
      h.call(null, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: ADMIN.email, password },
      });
    const first = await attempt('wrong-password');
    expect(first.statusCode).toBe(401);
    expect(codeOf(first)).toBe('INVALID_CREDENTIALS');
    expect(codeOf(await attempt('nobody'))).toBe('INVALID_CREDENTIALS');
    const third = await attempt('again-wrong');
    // A lockout looks exactly like bad credentials (no account enumeration).
    expect(third.statusCode).toBe(401);
    expect(codeOf(third)).toBe('INVALID_CREDENTIALS');
    // Even the right password is refused while locked (brute force protection).
    const locked = await attempt(ADMIN.password);
    expect(codeOf(locked)).toBe('INVALID_CREDENTIALS');
    expect(locked.headers['set-cookie']).toBeUndefined();
    const unknown = await h.call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'ghost@example.com', password: 'x' },
    });
    expect(codeOf(unknown)).toBe('INVALID_CREDENTIALS');
  });

  it('refuses an e-mail with NUL or control characters as a validation error and audits it', async () => {
    const h = await setup();
    for (const email of ['ad\u0000min@example.com', 'admin@example.com\u0007']) {
      const res = await h.call(null, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { email, password: 'Wrong!Password1' },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(codeOf(res)).toBe('VALIDATION_ERROR');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const admin = await h.login();
    const audit = await h.call(admin, {
      method: 'GET',
      url: '/api/audit?action=auth.login_failed',
    });
    const items = (audit.json() as { items: { userEmail: string; errorCode: string }[] }).items;
    expect(items.map((i) => i.userEmail).sort()).toEqual([
      'admin@example.com',
      'admin@example.com\u0007',
    ]);
    expect(items.every((i) => i.errorCode === 'VALIDATION_ERROR')).toBe(true);
  });

  it('refuses non-local accounts like a wrong password and never counts failures', async () => {
    const h = await setup({ LOGIN_MAX_ATTEMPTS: '2' });
    const u = await h.app.services.users.create({
      email: 'oidc@example.com',
      name: 'Oidc',
      password: PASSWORD,
      roles: [],
    });
    await h.database.db.execute(
      `UPDATE users SET identity_provider = 'oidc' WHERE id = '${u.id}'` as never,
    );
    const attempt = (email: string, password: string) =>
      h.call(null, { method: 'POST', url: '/api/auth/login', payload: { email, password } });
    const wrong = await attempt(ADMIN.email, 'wrong-password');
    for (let i = 0; i < 4; i++) {
      const res = await attempt('oidc@example.com', PASSWORD);
      expect(res.statusCode).toBe(wrong.statusCode);
      expect(res.json().error.code).toBe(wrong.json().error.code);
      expect(res.json().error.message).toBe(wrong.json().error.message);
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    const after = await h.app.services.users.findById(u.id);
    expect(after?.failedLogins).toBe(0);
    expect(after?.lockedUntil).toBeNull();
  });

  it('rate limits login attempts per IP', async () => {
    const h = await setup({ LOGIN_MAX_ATTEMPTS: '100' });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await h.call(null, {
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: `x${i}@example.com`, password: 'nope' },
      });
      codes.push(res.statusCode);
    }
    expect(codes).toContain(429);
  });

  it('rejects forged and expired sessions', async () => {
    const h = await setup();
    const forged = await h.call('A'.repeat(43), { method: 'GET', url: '/api/auth/me' });
    expect(forged.statusCode).toBe(401);
    const cookie = await h.login();
    // Expire every session in the database.
    await h.database.db.execute(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'` as never,
    );
    const expired = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(expired.statusCode).toBe(401);
  });

  it('rotates the session on login (session fixation)', async () => {
    const h = await setup();
    const first = await h.login();
    const res = await h.call(first, {
      method: 'POST',
      url: '/api/auth/login',
      payload: ADMIN,
    });
    const second = res.cookies.find((c) => c.name === 'dbx_session')!.value;
    expect(second).not.toBe(first);
    expect((await h.call(first, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(401);
    expect((await h.call(second, { method: 'GET', url: '/api/auth/me' })).statusCode).toBe(200);
  });
});

describe('client IP behind a reverse proxy', () => {
  it('reads X-Forwarded-For from a local proxy reaching the app through Docker NAT', async () => {
    const h = await setup({ TRUST_PROXY: 'loopback,uniquelocal' });
    const res = await h.call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: ADMIN.email, password: 'Wrong!Password1' },
      // Spoofed entries from the client come first; the proxy appends the real address.
      headers: { 'x-forwarded-for': '10.9.9.9, 203.0.113.7' },
      remoteAddress: '172.27.0.1',
    });
    expect(res.statusCode).toBe(401);
    const admin = await h.login();
    const audit = await h.call(admin, {
      method: 'GET',
      url: '/api/audit?action=auth.login_failed',
    });
    expect((audit.json() as { items: { ip: string }[] }).items[0]?.ip).toBe('203.0.113.7');
  });
});

describe('CSRF and request hygiene', () => {
  it('rejects state-changing requests from another origin or without origin', async () => {
    const h = await setup();
    const cookie = await h.login();
    const evil = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
      headers: { origin: 'https://evil.example' },
    });
    expect(evil.statusCode).toBe(403);
    expect(codeOf(evil)).toBe('CSRF_REJECTED');
    const none = await h.app.inject({
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES' },
      headers: { cookie: `dbx_session=${cookie}` },
    });
    expect(codeOf(none)).toBe('CSRF_REJECTED');
  });

  it('only accepts JSON bodies and rejects unknown fields (mass assignment)', async () => {
    const h = await setup();
    const cookie = await h.login();
    const text = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: 'SHOW TABLES',
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(400);
    expect(codeOf(text)).toBe('VALIDATION_ERROR');
    const extra = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SHOW TABLES', role: 'ADMIN' },
    });
    expect(codeOf(extra)).toBe('VALIDATION_ERROR');
    const proto = await h.call(cookie, {
      method: 'POST',
      url: '/api/saved-queries',
      payload: '{"name":"x","sql":"SHOW TABLES","__proto__":{"admin":true}}',
      headers: { 'content-type': 'application/json' },
    });
    expect([400]).toContain(proto.statusCode);
    expect(({} as Record<string, unknown>).admin).toBeUndefined();
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const h = await setup();
    const res = await h.call(null, { method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('NOT_FOUND');
  });
});

describe('queries (Sankhya read path)', () => {
  /** A mock gateway whose issued bearer tokens the test can see. */
  async function capturingMock() {
    const mock = await createMockSankhya();
    const tokens: string[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await mock.fetch(input, init);
      const text = await res.clone().text();
      const m = /"access_token":"([^"]+)"/.exec(text);
      if (m) tokens.push(m[1]!);
      return res;
    }) as typeof globalThis.fetch;
    return { mock, tokens, gateway: { ...mock, fetch } };
  }

  it('runs a SELECT through the mock gateway and records history without results', async () => {
    const { mock, tokens, gateway } = await capturingMock();
    const h = await setup({}, { sankhya: { mockGateway: () => Promise.resolve(gateway) } });
    const cookie = await h.createUser('VIEWER');
    const sel = await query(h, cookie, 'SELECT CODPARC, NOMEPARC FROM TGFPAR ORDER BY CODPARC');
    expect(sel.statusCode, sel.body).toBe(200);
    const body = sel.json();
    expect(body).toMatchObject({
      type: 'result',
      kind: 'SELECT',
      connectionId: 'env-default',
      resource: 'TGFPAR',
      truncated: false,
    });
    expect(body.columns.map((c: { name: string }) => c.name)).toEqual(['CODPARC', 'NOMEPARC']);
    expect(body.rowCount).toBeGreaterThan(5);
    expect(body.rows[0][0]).toBe(1);
    const sent = mock.calls.filter((c) => c.serviceName === 'DbExplorerSP.executeQuery');
    expect(sent.length).toBeGreaterThan(0);

    // The response never carries the bearer token or the connection credentials.
    expect(tokens.length).toBeGreaterThan(0);
    for (const secret of [...tokens, ...Object.values(MOCK_CREDENTIALS)])
      expect(sel.body).not.toContain(secret);

    const hist = await h.call(cookie, { method: 'GET', url: '/api/history' });
    const items = hist.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      status: 'success',
      sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR ORDER BY CODPARC',
      operation: 'SELECT',
      resource: 'TGFPAR',
    });
    // No result data stored.
    const firstName = String(body.rows[0][1]);
    expect(JSON.stringify(items)).not.toContain(firstName);
  });

  it('reads through an explicit SQL Server connection (TOP row cap)', async () => {
    const h = await setup();
    const conn = await h.app.services.connections.create({
      name: 'Demo MSSQL',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: 'mock://local',
      dialect: 'mssql',
      secrets: { ...MOCK_CREDENTIALS },
    });
    const cookie = await h.login();
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SELECT CODCID, NOMECID FROM TSICID', connectionId: conn.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ connectionId: conn.id, resource: 'TSICID' });
    expect(res.json().rowCount).toBeGreaterThan(0);
  });

  it('refuses at the token gate with SQL_FORBIDDEN and audits the denial', async () => {
    const h = await setup();
    const cookie = await h.createUser('VIEWER');
    for (const sql of [
      'SELECT CODPARC FROM TGFPAR; DELETE FROM TGFPAR',
      'SELECT CODPARC FROM TGFPAR /* x */',
    ]) {
      const res = await query(h, cookie, sql);
      expect(res.statusCode, sql).toBe(400);
      expect(codeOf(res), sql).toBe('SQL_FORBIDDEN');
    }

    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=read.denied' });
    expect(audit.json().total).toBe(2);
    expect(audit.json().items[0]).toMatchObject({
      status: 'denied',
      operation: 'SELECT',
      errorCode: 'SQL_FORBIDDEN',
    });
  });

  it('refuses a user without QUERY.SELECT with FORBIDDEN and audits it', async () => {
    const h = await setup();
    const nobody = await h.createUser([]);
    const res = await query(h, nobody, 'SELECT CODPARC FROM TGFPAR');
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=read.denied' });
    expect(audit.json().items[0]).toMatchObject({
      errorCode: 'FORBIDDEN',
      status: 'denied',
      operation: 'SELECT',
      resource: null,
    });
  });

  it('answers a user without QUERY.SELECT the same way for any table or connection', async () => {
    const { mock, gateway } = await capturingMock();
    const h = await setup({}, { sankhya: { mockGateway: () => Promise.resolve(gateway) } });
    const nobody = await h.createUser([]);
    const probes = [
      { sql: 'SELECT CODPARC FROM TGFPAR' },
      { sql: 'SELECT X FROM TGFXYZ' },
      { sql: 'SELECT CODPARC FROM TGFPAR', connectionId: '00000000-0000-4000-8000-000000000000' },
      { sql: 'SELECT X FROM TGFXYZ', connectionId: '00000000-0000-4000-8000-000000000000' },
    ];
    const bodies = new Set<string>();
    for (const payload of probes) {
      const res = await h.call(nobody, { method: 'POST', url: '/api/query', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(403);
      const { error } = res.json() as { error: { code: string; message: string } };
      bodies.add(JSON.stringify({ code: error.code, message: error.message }));
    }
    for (const connectionId of ['env-default', '00000000-0000-4000-8000-000000000000']) {
      const res = await h.call(nobody, {
        method: 'GET',
        url: `/api/schema?connectionId=${connectionId}`,
      });
      expect(res.statusCode).toBe(403);
      expect(codeOf(res)).toBe('FORBIDDEN');
    }
    expect(bodies.size).toBe(1);
    expect(JSON.parse([...bodies][0]!)).toMatchObject({ code: 'FORBIDDEN' });
    expect(mock.calls).toHaveLength(0);

    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=read.denied' });
    const items = audit.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    for (const item of items)
      expect(item).toMatchObject({ errorCode: 'FORBIDDEN', resource: null });
  });

  it('maps unknown tables and unparseable SQL to stable codes', async () => {
    const h = await setup();
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, 'SELECT X FROM TGFXYZ'))).toBe('RESOURCE_NOT_FOUND');
    expect(codeOf(await query(h, cookie, 'SELECT * FROM TGFPAR WHERE'))).toMatch(
      /SQL_PARSE_ERROR|SQL_UNSUPPORTED/,
    );
    expect(codeOf(await query(h, cookie, 'BEGIN'))).toMatch(
      /SQL_FORBIDDEN|SQL_PARSE_ERROR|SQL_UNSUPPORTED/,
    );
  });

  it('caps the result at SANKHYA_MAX_ROWS and flags it as truncated', async () => {
    const h = await setup({ SANKHYA_MAX_ROWS: '5' });
    const cookie = await h.login();
    const body = (await query(h, cookie, 'SELECT CODPARC FROM TGFPAR')).json();
    expect(body).toMatchObject({ rowCount: 5, truncated: true });
    expect(body.rows).toHaveLength(5);
    expect(body.messages.join(' ')).toContain('truncated');
  });

  it('cancels a running read with QUERY_CANCELLED', async () => {
    const mock = await createMockSankhya();
    const h = await setup({}, { sankhya: { mockGateway: () => Promise.resolve(mock) } });
    const cookie = await h.login();
    // Warm the catalog so the only slow call is the read itself.
    expect((await query(h, cookie, 'SELECT CODPARC FROM TGFPAR')).statusCode).toBe(200);
    mock.inject({ type: 'delay', ms: 10_000 }, { sqlIncludes: 'FROM TGFPRO' });
    const executionId = 'cancel-test-0001';
    const running = h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SELECT CODPROD FROM TGFPRO', executionId },
    });
    let cancelled = false;
    for (let i = 0; i < 200 && !cancelled; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const res = await h.call(cookie, {
        method: 'POST',
        url: '/api/query/cancel',
        payload: { executionId },
      });
      cancelled = res.json().cancelled === true;
    }
    expect(cancelled).toBe(true);
    const res = await running;
    expect(codeOf(res)).toBe('QUERY_CANCELLED');
    const hist = await h.call(cookie, { method: 'GET', url: '/api/history' });
    expect(hist.json().items[0]).toMatchObject({ status: 'cancelled' });
  });

  it('needs a connection: VALIDATION_ERROR without one and no SANKHYA_* default', async () => {
    const h = await setup({ SANKHYA_CLIENT_ID: '' });
    const cookie = await h.login();
    const res = await query(h, cookie, 'SELECT CODPARC FROM TGFPAR');
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('VALIDATION_ERROR');
    const bad = await h.call(cookie, {
      method: 'POST',
      url: '/api/query',
      payload: { sql: 'SELECT CODPARC FROM TGFPAR', connectionId: 'not-a-connection' },
    });
    expect(codeOf(bad)).toBe('VALIDATION_ERROR');
  });

  it('serves the catalog of a connection at /api/schema, behind QUERY.SELECT', async () => {
    const h = await setup();
    const cookie = await h.createUser('VIEWER');
    const res = await h.call(cookie, {
      method: 'GET',
      url: '/api/schema?connectionId=env-default',
    });
    expect(res.statusCode, res.body).toBe(200);
    const tables = res.json().catalog.tables as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['TGFPAR', 'TSICID']));
    for (const secret of Object.values(MOCK_CREDENTIALS)) expect(res.body).not.toContain(secret);

    const nobody = await h.createUser([]);
    const denied = await h.call(nobody, {
      method: 'GET',
      url: '/api/schema?connectionId=env-default',
    });
    expect(denied.statusCode).toBe(403);
    const bad = await h.call(cookie, { method: 'GET', url: '/api/schema?connectionId=x' });
    expect(codeOf(bad)).toBe('VALIDATION_ERROR');
  });
});

describe('writes (fail closed)', () => {
  const MUTATIONS = [
    "UPDATE TGFPAR SET NOMEPARC = 'X' WHERE CODPARC = 1",
    "INSERT INTO TGFPAR (CODPARC, NOMEPARC) VALUES (999, 'X')",
    'DELETE FROM TGFPAR WHERE CODPARC = 1',
    'DROP TABLE TGFPAR',
    'CREATE TABLE TGFXYZ (ID INT)',
  ];

  it('refuses every mutation with SQL_UNSUPPORTED, even with every write switch on', async () => {
    const mock = await createMockSankhya();
    const h = await setup(WRITABLE_ENV, { sankhya: { mockGateway: () => Promise.resolve(mock) } });
    const cookie = await h.login();
    for (const sql of MUTATIONS) {
      for (const payload of [{ sql }, { sql, connectionId: 'env-default' }]) {
        const res = await h.call(cookie, { method: 'POST', url: '/api/query', payload });
        expect(res.statusCode, sql).toBe(400);
        // INSERT / UPDATE / DELETE get a pointer to the preview; DDL is simply refused.
        expect(res.json().error, sql).toMatchObject(
          /^(INSERT|UPDATE|DELETE)/.test(sql)
            ? {
                code: 'SQL_UNSUPPORTED',
                message: 'Mutations are never executed here. Preview them with /api/query/preview.',
                details: { preview: '/api/query/preview' },
              }
            : { code: 'SQL_UNSUPPORTED', message: 'Mutations are not available yet.' },
        );
      }
    }
    // Nothing reached the gateway.
    expect(mock.calls).toHaveLength(0);

    const audit = await h.call(cookie, { method: 'GET', url: '/api/audit?action=write.denied' });
    expect(audit.json().total).toBe(MUTATIONS.length * 2);
    expect(audit.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'denied',
          operation: 'UPDATE',
          resource: 'TGFPAR',
          errorCode: 'SQL_UNSUPPORTED',
        }),
      ]),
    );
    const hist = await h.call(cookie, { method: 'GET', url: '/api/history' });
    expect(hist.json().items[0]).toMatchObject({ status: 'error', errorCode: 'SQL_UNSUPPORTED' });
  });

  const DENIED_UPDATE = {
    status: 'denied',
    operation: 'UPDATE',
    resource: 'TGFPAR',
    errorCode: 'SQL_UNSUPPORTED',
  };

  it('refuses a mutation the same way for a user without any permission', async () => {
    const mock = await createMockSankhya();
    const h = await setup(WRITABLE_ENV, { sankhya: { mockGateway: () => Promise.resolve(mock) } });
    const nobody = await h.createUser([]);
    const res = await query(h, nobody, MUTATIONS[0]!);
    expect(codeOf(res)).toBe('SQL_UNSUPPORTED');
    expect(mock.calls).toHaveLength(0);
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=write.denied' });
    expect(audit.json().total).toBe(1);
    expect(audit.json().items[0]).toMatchObject(DENIED_UPDATE);
  });

  it('refuses /api/query/confirm and audits the attempt', async () => {
    const mock = await createMockSankhya();
    const h = await setup(WRITABLE_ENV, { sankhya: { mockGateway: () => Promise.resolve(mock) } });
    const cookie = await h.createUser('OPERATOR');
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/query/confirm',
      payload: { sql: MUTATIONS[0], token: 'any.token' },
    });
    expect(res.statusCode).toBe(400);
    expect(codeOf(res)).toBe('SQL_UNSUPPORTED');
    expect(mock.calls).toHaveLength(0);
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=write.denied' });
    expect(audit.json().total).toBe(1);
    expect(audit.json().items[0]).toMatchObject(DENIED_UPDATE);
  });

  it('answers an unauthenticated mutation with 401 and writes no audit row', async () => {
    const mock = await createMockSankhya();
    const h = await setup(WRITABLE_ENV, { sankhya: { mockGateway: () => Promise.resolve(mock) } });
    for (const url of ['/api/query', '/api/query/confirm']) {
      const res = await h.call(null, {
        method: 'POST',
        url,
        payload: { sql: MUTATIONS[0], token: 'any.token' },
      });
      expect(res.statusCode, url).toBe(401);
    }
    expect(mock.calls).toHaveLength(0);
    const admin = await h.login();
    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=write.denied' });
    expect(audit.json().total).toBe(0);
  });
});

describe('saved queries', () => {
  it('supports CRUD and duplicate, scoped to the owner (no IDOR)', async () => {
    const h = await setup();
    const a = await h.createUser('VIEWER');
    const b = await h.createUser('VIEWER');
    const created = await h.call(a, {
      method: 'POST',
      url: '/api/saved-queries',
      payload: { name: 'Clientes SP', sql: "SELECT * FROM clientes WHERE estado = 'SP' LIMIT 10" },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id as string;
    const dup = await h.call(a, {
      method: 'POST',
      url: `/api/saved-queries/${id}/duplicate`,
      payload: {},
    });
    expect(dup.json().item.name).toContain('(cópia)');
    expect(
      (await h.call(a, { method: 'GET', url: '/api/saved-queries' })).json().items,
    ).toHaveLength(2);

    expect(
      (await h.call(b, { method: 'GET', url: '/api/saved-queries' })).json().items,
    ).toHaveLength(0);
    const steal = await h.call(b, {
      method: 'PUT',
      url: `/api/saved-queries/${id}`,
      payload: { name: 'pwned' },
    });
    expect(steal.statusCode).toBe(404);
    expect(
      (await h.call(b, { method: 'DELETE', url: `/api/saved-queries/${id}` })).statusCode,
    ).toBe(404);

    const upd = await h.call(a, {
      method: 'PUT',
      url: `/api/saved-queries/${id}`,
      payload: { name: 'Clientes SP v2' },
    });
    expect(upd.json().item.name).toBe('Clientes SP v2');
    expect(
      (await h.call(a, { method: 'DELETE', url: `/api/saved-queries/${id}` })).statusCode,
    ).toBe(200);
  });
});

describe('admin', () => {
  it('restricts user management and audit to ADMIN', async () => {
    const h = await setup();
    const op = await h.createUser('OPERATOR');
    expect((await h.call(op, { method: 'GET', url: '/api/admin/users' })).statusCode).toBe(403);
    expect((await h.call(op, { method: 'GET', url: '/api/audit' })).statusCode).toBe(403);

    const admin = await h.login();
    const created = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: {
        email: 'nova@example.com',
        name: 'Nova',
        roles: ['VIEWER'],
        password: 'Nova!Strong#Pass1',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id;
    expect(created.json().item.mustChangePassword).toBe(true);
    const weak = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: {
        email: 'fraca@example.com',
        name: 'Fraca',
        roles: ['VIEWER'],
        password: 'password1234',
      },
    });
    expect(codeOf(weak)).toBe('VALIDATION_ERROR');

    const role = await h.call(admin, {
      method: 'PUT',
      url: `/api/admin/users/${id}/roles`,
      payload: { roles: ['OPERATOR'] },
    });
    expect(role.statusCode, role.body).toBe(200);
    expect(role.json().item.directRoles).toEqual(['OPERATOR']);
    expect(role.json().item.permissions).toContain('DATA.UPDATE');
    const unknown = await h.call(admin, {
      method: 'PUT',
      url: `/api/admin/users/${id}/roles`,
      payload: { roles: ['ROOT'] },
    });
    expect(codeOf(unknown)).toBe('VALIDATION_ERROR');
    const deactivate = await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      payload: { active: false },
    });
    expect(deactivate.json().item.active).toBe(false);
    const login = await h.call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'nova@example.com', password: 'Nova!Strong#Pass1' },
    });
    expect(login.statusCode).toBe(401);

    // A reset forces the user to choose a new password before using the app.
    await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/users/${id}`,
      payload: { active: true },
    });
    await h.call(admin, {
      method: 'POST',
      url: `/api/admin/users/${id}/reset-password`,
      payload: { password: 'Reset!Strong#Pass2' },
    });
    const temp = await h.login('nova@example.com', 'Reset!Strong#Pass2');
    expect(codeOf(await query(h, temp, READ))).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await h.call(temp, {
      method: 'POST',
      url: '/api/auth/change-password',
      payload: { currentPassword: 'Reset!Strong#Pass2', newPassword: 'Mine!Strong#Pass3' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const fresh = changed.cookies.find((c) => c.name === 'dbx_session')!.value;
    expect((await query(h, fresh, READ)).statusCode).toBe(200);
    expect((await query(h, temp, READ)).statusCode).toBe(401);

    const audit = await h.call(admin, { method: 'GET', url: '/api/audit?action=user.create' });
    expect(audit.json().total).toBe(1);
  });

  it('forces an admin with a one-time password to replace it before anything else', async () => {
    const h = await setup();
    const admin = await h.app.services.users.findByEmail(ADMIN.email);
    await h.app.services.users.setPassword(admin!.id, ADMIN.password, true);
    const cookie = await h.login();
    expect(codeOf(await query(h, cookie, READ))).toBe('PASSWORD_CHANGE_REQUIRED');
    const me = await h.call(cookie, { method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.mustChangePassword).toBe(true);
  });

  it('reports system status', async () => {
    const h = await setup();
    const admin = await h.login();
    const res = await h.call(admin, { method: 'GET', url: '/api/status' });
    expect(res.json()).toMatchObject({
      database: { status: 'ok' },
      sankhya: { state: 'READY', mode: 'mock', readyConnections: 1 },
      writes: { safeMode: true, globalWriteEnabled: false, available: false },
    });
    expect(res.json()).not.toHaveProperty('ai');
  });

  it('grants permissions through groups and revokes them when the group is disabled', async () => {
    const h = await setup();
    const admin = await h.login();
    const ana = await h.createUser([], 'ana@example.com');
    // No role, no permission: not even reads.
    expect((await h.call(ana, { method: 'GET', url: '/api/schema' })).statusCode).toBe(403);
    expect(codeOf(await query(h, ana, READ))).toBe('FORBIDDEN');

    const me = async () =>
      (await h.call(ana, { method: 'GET', url: '/api/auth/me' })).json().user as {
        roles: string[];
        permissions: string[];
      };
    expect((await me()).permissions).toEqual([]);

    const group = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/groups',
      payload: { name: 'Faturamento' },
    });
    expect(group.statusCode, group.body).toBe(201);
    const gid = group.json().item.id as string;
    const anaId = (await h.app.services.users.findByEmail('ana@example.com'))!.id;
    const put = (url: string, payload: object) => h.call(admin, { method: 'PUT', url, payload });
    expect((await put(`/api/admin/groups/${gid}/roles`, { roles: ['OPERATOR'] })).statusCode).toBe(
      200,
    );
    expect((await put(`/api/admin/groups/${gid}/members`, { userIds: [anaId] })).statusCode).toBe(
      200,
    );

    // Effective at the next request, without a new login.
    expect(await me()).toMatchObject({ roles: ['OPERATOR'] });
    expect((await me()).permissions).toEqual(expect.arrayContaining(['DATA.UPDATE']));
    expect((await query(h, ana, READ)).statusCode).toBe(200);

    const off = await h.call(admin, {
      method: 'PATCH',
      url: `/api/admin/groups/${gid}`,
      payload: { active: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await me()).permissions).toEqual([]);
    expect(codeOf(await query(h, ana, READ))).toBe('FORBIDDEN');

    // Group and role administration need their own permissions.
    const op = await h.createUser('OPERATOR');
    expect((await h.call(op, { method: 'GET', url: '/api/admin/groups' })).statusCode).toBe(403);
    expect((await h.call(op, { method: 'GET', url: '/api/admin/roles' })).statusCode).toBe(403);
  });
});

describe('self-escalation', () => {
  it("refuses and audits changes to the actor's own permissions over HTTP", async () => {
    const h = await setup();
    const admin = await h.login();
    const adminId = (await h.app.services.users.findByEmail(ADMIN.email))!.id;
    const call = (method: 'PUT' | 'PATCH' | 'POST' | 'DELETE', url: string, payload?: object) =>
      h.call(admin, { method, url, ...(payload ? { payload } : {}) });

    // A group carrying OPERATOR: the admin cannot add themselves to it.
    const gid = (await call('POST', '/api/admin/groups', { name: 'Operação' })).json().item
      .id as string;
    expect(
      (await call('PUT', `/api/admin/groups/${gid}/roles`, { roles: ['OPERATOR'] })).statusCode,
    ).toBe(200);
    const join = await call('PUT', `/api/admin/groups/${gid}/members`, { userIds: [adminId] });
    expect(codeOf(join)).toBe('FORBIDDEN');
    expect(
      codeOf(
        await call('PUT', `/api/admin/users/${adminId}/roles`, { roles: ['ADMIN', 'OPERATOR'] }),
      ),
    ).toBe('FORBIDDEN');

    // A custom role the admin holds (assigned by a second admin) cannot be widened by them.
    const rid = (
      await call('POST', '/api/admin/roles', { key: 'EXTRA', name: 'Extra', permissions: [] })
    ).json().item.id as string;
    // The peer drops the bootstrap admin's OPERATOR role, so it must cover that account.
    const peer = await h.createUser(['ADMIN', 'OPERATOR'], 'peer@example.com');
    const assign = await h.call(peer, {
      method: 'PUT',
      url: `/api/admin/users/${adminId}/roles`,
      payload: { roles: ['ADMIN', 'EXTRA'] },
    });
    expect(assign.statusCode, assign.body).toBe(200);
    const widen = await call('PATCH', `/api/admin/roles/${rid}`, { permissions: ['DATA.DELETE'] });
    expect(codeOf(widen)).toBe('FORBIDDEN');

    const me = (await h.call(admin, { method: 'GET', url: '/api/auth/me' })).json().user as {
      permissions: string[];
    };
    expect(me.permissions.filter((p) => /^(DATA|DDL|SANKHYA)\./.test(p))).toEqual([]);

    const denied = await h.call(admin, { method: 'GET', url: '/api/audit?status=denied' });
    expect(
      denied
        .json()
        .items.map((e: { action: string }) => e.action)
        .sort(),
    ).toEqual(['group.members', 'role.update', 'user.roles']);
  });

  it('needs ADMIN.ROLES to assign roles, at creation or later, and lets an admin holding OPERATOR provision operators', async () => {
    const h = await setup();
    const admin = await h.login();
    await h.app.services.authz.createRole(
      { key: 'USER_ADMIN', name: 'Cadastro', permissions: ['ADMIN.USERS'] },
      (await h.app.services.users.findByEmail(ADMIN.email))!.id,
    );
    const clerk = await h.createUser('USER_ADMIN');
    const newUser = (cookie: string, email: string) =>
      h.call(cookie, {
        method: 'POST',
        url: '/api/admin/users',
        payload: {
          email,
          name: 'Nova',
          roles: ['ADMIN', 'OPERATOR'],
          password: 'Nova!Strong#Pass1',
        },
      });
    const refused = await newUser(clerk, 'sock@example.com');
    expect(codeOf(refused)).toBe('FORBIDDEN');
    expect(refused.json().error.details).toMatchObject({ permission: 'ADMIN.ROLES' });

    const created = await newUser(admin, 'op@example.com');
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id as string;
    expect(created.json().item.permissions).toContain('DATA.UPDATE');
    const change = await h.call(clerk, {
      method: 'PUT',
      url: `/api/admin/users/${id}/roles`,
      payload: { roles: ['VIEWER'] },
    });
    expect(codeOf(change)).toBe('FORBIDDEN');
  });
});

describe('account takeover', () => {
  it('refuses and audits resetting or reactivating a stronger account', async () => {
    const h = await setup();
    const admin = await h.login();
    const adminId = (await h.app.services.users.findByEmail(ADMIN.email))!.id;
    await h.app.services.authz.createRole(
      { key: 'USER_ADMIN', name: 'Cadastro', permissions: ['ADMIN.USERS'] },
      adminId,
    );
    const clerk = await h.createUser('USER_ADMIN', 'clerk@example.com');
    await h.createUser('ADMIN', 'second@example.com');
    const secondId = (await h.app.services.users.findByEmail('second@example.com'))!.id;

    const reset = await h.call(clerk, {
      method: 'POST',
      url: `/api/admin/users/${adminId}/reset-password`,
      payload: { password: 'Taken!Strong#Pass1' },
    });
    expect(codeOf(reset)).toBe('FORBIDDEN');
    // The admin's password is unchanged.
    await h.login();

    const off = await h.call(clerk, {
      method: 'PATCH',
      url: `/api/admin/users/${secondId}`,
      payload: { active: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    const on = await h.call(clerk, {
      method: 'PATCH',
      url: `/api/admin/users/${secondId}`,
      payload: { active: true },
    });
    expect(codeOf(on)).toBe('FORBIDDEN');

    const denied = await h.call(admin, { method: 'GET', url: '/api/audit?status=denied' });
    expect(
      denied
        .json()
        .items.map((e: { action: string }) => e.action)
        .sort(),
    ).toEqual(['user.reset_password', 'user.update']);
  });
});

describe("granting beyond the actor's permissions", () => {
  it('refuses and audits an ADMIN without DATA.* creating or promoting an OPERATOR', async () => {
    const h = await setup();
    const root = await h.login(); // bootstrap admin: ADMIN + OPERATOR
    const admin = await h.createUser('ADMIN', 'plain-admin@example.com');
    const created = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: { email: 'op@example.com', name: 'Op', roles: ['OPERATOR'], password: PASSWORD },
    });
    expect(codeOf(created)).toBe('FORBIDDEN');
    const viewer = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/users',
      payload: { email: 'v@example.com', name: 'V', roles: ['VIEWER'], password: PASSWORD },
    });
    expect(viewer.statusCode, viewer.body).toBe(201);
    const promote = await h.call(admin, {
      method: 'PUT',
      url: `/api/admin/users/${viewer.json().item.id as string}/roles`,
      payload: { roles: ['OPERATOR'] },
    });
    expect(codeOf(promote)).toBe('FORBIDDEN');
    const role = await h.call(admin, {
      method: 'POST',
      url: '/api/admin/roles',
      payload: { key: 'EDITOR', name: 'Editor', permissions: ['QUERY.SELECT', 'DATA.UPDATE'] },
    });
    expect(codeOf(role)).toBe('FORBIDDEN');
    expect(role.json().error.details).toMatchObject({ missing: ['DATA.UPDATE'] });

    const denied = await h.call(root, { method: 'GET', url: '/api/audit?status=denied' });
    expect(
      denied
        .json()
        .items.map((e: { action: string }) => e.action)
        .sort(),
    ).toEqual(['role.create', 'user.create', 'user.roles']);
  });
});

describe('removed features', () => {
  it.each([
    ['POST', '/api/ai/generate'],
    ['GET', '/api/inspector/calls'],
    ['POST', '/api/inspector/execute'],
  ] as const)('%s %s is gone (404 JSON)', async (method, url) => {
    const h = await setup();
    const cookie = await h.login();
    const res = await h.call(cookie, {
      method,
      url,
      ...(method === 'POST' ? { payload: {} } : {}),
    });
    expect(res.statusCode).toBe(404);
    expect(codeOf(res)).toBe('NOT_FOUND');
  });

  it('does not advertise an AI assistant in /api/meta', async () => {
    const h = await setup();
    const res = await h.app.inject({ method: 'GET', url: '/api/meta' });
    expect(res.json()).not.toHaveProperty('aiEnabled');
  });

  it('exposes demoMode in /api/meta so the UI can show the DEMO banner', async () => {
    const off = await setup();
    expect((await off.app.inject({ method: 'GET', url: '/api/meta' })).json()).toMatchObject({
      demoMode: false,
    });
    const on = await setup({ DEMO_MODE: 'true' });
    expect((await on.app.inject({ method: 'GET', url: '/api/meta' })).json()).toMatchObject({
      demoMode: true,
    });
  });
});

describe('secret handling (gateway fault that echoes the credentials)', () => {
  it('never returns or logs the Sankhya credentials, even in errors', async () => {
    const mock = await createMockSankhya();
    const echoed = Object.values(MOCK_CREDENTIALS).join(' ');
    let faults = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('executeQuery')) {
        faults++;
        // A careless upstream that echoes the credentials back in its service error
        // (HTTP 200 with status "0": not retryable, so the test does not wait on backoff).
        return new Response(JSON.stringify({ status: '0', statusMessage: `bad ${echoed}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return mock.fetch(input, init);
    }) as typeof globalThis.fetch;
    const h = await setup(
      {},
      { sankhya: { mockGateway: () => Promise.resolve({ ...mock, fetch }) } },
    );
    const cookie = await h.login();
    const res = await query(h, cookie, READ);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(faults).toBeGreaterThan(0);

    const status = await h.call(cookie, { method: 'GET', url: '/api/status' });
    const history = await h.call(cookie, { method: 'GET', url: '/api/history' });
    const audit = await h.call(cookie, { method: 'GET', url: '/api/audit' });
    for (const r of [res, status, history, audit]) {
      for (const secret of Object.values(MOCK_CREDENTIALS)) expect(r.body).not.toContain(secret);
    }
    const logs = h.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const secret of Object.values(MOCK_CREDENTIALS)) expect(logs).not.toContain(secret);
    expect(logs).not.toContain(ADMIN.password);
    expect(logs).not.toContain(cookie);
  });
});
