import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { buildApp } from '../app';
import { loadConfig } from '../config';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';

// Fictitious ids, used only by these tests.
const PLAN_A = '00000000-0000-4000-8000-0000000000c1';
const PLAN_B = '00000000-0000-4000-8000-0000000000c2';
const CONN = '00000000-0000-4000-8000-0000000000aa';

const ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  BOOTSTRAP_ADMIN_PASSWORD: ADMIN.password,
  BOOTSTRAP_ADMIN_ROLES: 'ADMIN',
  LOG_LEVEL: 'silent',
};

interface Harness {
  app: FastifyInstance;
  login(email: string, password: string): Promise<string>;
  get(cookie: string | null, url: string): Promise<Awaited<ReturnType<FastifyInstance['inject']>>>;
}

const open: Array<{ app: FastifyInstance; database: DatabaseHandle }> = [];
afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

async function setup(): Promise<Harness> {
  const config = loadConfig(ENV);
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const app = await buildApp({ config, database, logger: false });
  open.push({ app, database });
  await app.services.users.bootstrapAdmin(config.bootstrapAdmin);
  const admin = await app.services.users.findByEmail(ADMIN.email);
  if (admin) await app.services.users.setPassword(admin.id, ADMIN.password, false);

  const call = (cookie: string | null, opts: InjectOptions) =>
    app.inject({
      ...opts,
      headers: {
        origin: ORIGIN,
        ...(cookie ? { cookie: `${config.session.cookieName}=${cookie}` } : {}),
      },
    });
  const login = async (email: string, password: string) => {
    const res = await call(null, {
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.cookies.find((c) => c.name === config.session.cookieName)!.value;
  };
  return { app, login, get: (cookie, url) => call(cookie, { method: 'GET', url }) };
}

async function seed(h: Harness): Promise<void> {
  const { audit } = h.app.services;
  const base = {
    connectionId: CONN,
    environment: 'SANDBOX' as const,
    capability: 'DATA.UPDATE',
  };
  await audit.recordPlanCreated({ ...base, planId: PLAN_A }, {});
  await audit.recordPlanExecuted(
    { ...base, planId: PLAN_A },
    { outcome: 'success', before: [{ CODPARC: 1, SENHA: 'old-pass-1' }] },
  );
  await audit.recordPlanDenied({ ...base, planId: PLAN_B, environment: 'PRODUCTION' }, {});
}

describe('GET /api/audit', () => {
  it('requires AUDIT.READ', async () => {
    const h = await setup();
    expect((await h.get(null, '/api/audit')).statusCode).toBe(401);

    await h.app.services.users.create({
      email: 'operator@example.com',
      name: 'Operator',
      password: PASSWORD,
      roles: ['OPERATOR'],
    });
    const op = await h.login('operator@example.com', PASSWORD);
    const denied = await h.get(op, `/api/audit?planId=${PLAN_A}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.details).toMatchObject({ permission: 'AUDIT.READ' });

    // A role holding only AUDIT.READ is enough: no role name or admin check is involved.
    await h.app.services.authz.createRole({
      key: 'AUDITOR',
      name: 'Auditor',
      permissions: ['AUDIT.READ'],
    });
    await h.app.services.users.create({
      email: 'auditor@example.com',
      name: 'Auditor',
      password: PASSWORD,
      roles: ['AUDITOR'],
    });
    const auditor = await h.login('auditor@example.com', PASSWORD);
    expect((await h.get(auditor, '/api/audit')).statusCode).toBe(200);
  });

  it('searches by plan id and returns the new columns with redacted snapshots', async () => {
    const h = await setup();
    await seed(h);
    const admin = await h.login(ADMIN.email, ADMIN.password);

    const res = await h.get(admin, `/api/audit?planId=${PLAN_A}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(2);
    expect(body.items.map((i) => i.action).sort()).toEqual(['PLAN_CREATED', 'PLAN_EXECUTED']);
    const executed = body.items.find((i) => i.action === 'PLAN_EXECUTED')!;
    expect(executed).toMatchObject({
      planId: PLAN_A,
      connectionId: CONN,
      environment: 'SANDBOX',
      capability: 'DATA.UPDATE',
      status: 'success',
    });
    expect(res.body).not.toContain('old-pass-1');
  });

  it('filters by environment, connection and outcome', async () => {
    const h = await setup();
    await seed(h);
    const admin = await h.login(ADMIN.email, ADMIN.password);
    const total = async (q: string) => (await h.get(admin, `/api/audit?${q}`)).json().total;
    expect(await total('environment=PRODUCTION')).toBe(1);
    expect(await total(`connectionId=${CONN}&outcome=denied`)).toBe(1);
    expect(await total('status=success&action=PLAN_EXECUTED')).toBe(1);
  });

  it('rejects invalid filters and unbounded pages', async () => {
    const h = await setup();
    const admin = await h.login(ADMIN.email, ADMIN.password);
    for (const q of [
      'planId=not-a-uuid',
      'environment=LOCAL',
      'connectionId=x',
      'userId=1',
      'limit=201',
      'limit=0',
      'outcome=ok',
      'status=success&outcome=denied',
      'unknown=1',
    ]) {
      const res = await h.get(admin, `/api/audit?${q}`);
      expect(res.statusCode, q).toBe(400);
    }
  });
});
