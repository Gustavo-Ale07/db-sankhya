import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { createDatabase, rolePermissions, roles } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS } from '@dbx/sankhya-client/mock';
import type { Permission } from '@dbx/shared';
import { buildApp } from '../../app';
import { loadConfig } from '../../config';
import { MOCK_BASE_URL } from '../../services/sankhya-runtime';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { email: 'admin@example.com', password: 'Adm1n!Strong#Pass' };
const PASSWORD = 'User!Strong#Pass9';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  BOOTSTRAP_ADMIN_EMAIL: ADMIN.email,
  BOOTSTRAP_ADMIN_ROLES: 'ADMIN',
  LOG_LEVEL: 'silent',
  SANKHYA_MODE: 'mock',
  SANKHYA_BASE_URL: 'https://gateway.example.com',
  SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  SANKHYA_CLIENT_ID: MOCK_CREDENTIALS.clientId,
  SANKHYA_CLIENT_SECRET: MOCK_CREDENTIALS.clientSecret,
  SANKHYA_X_TOKEN: MOCK_CREDENTIALS.xToken,
  SANKHYA_DIALECT: 'oracle',
};

/** Fictitious credentials of a stored connection; none of them may ever be echoed back. */
const SECRETS = {
  clientId: 'stored-client-id-0123456789',
  clientSecret: 'stored-client-secret-value-x1',
  xToken: 'stored-x-token-value-y2',
};
const ROTATED = { clientSecret: 'rotated-client-secret-value-z3' };

type Response = Awaited<ReturnType<FastifyInstance['inject']>>;

interface Harness {
  app: FastifyInstance;
  adminId: string;
  admin: string;
  call(cookie: string | null, opts: InjectOptions): Promise<Response>;
  /** A user holding exactly `permissions` through a custom role; returns a session cookie. */
  userWith(permissions: Permission[]): Promise<string>;
  /**
   * A user holding `roleKeys`, plus a role seeded directly with `extra` permissions when given
   * (no acting user, so nothing the bootstrap admin lacks is refused). Returns the id and a
   * session cookie.
   */
  userWithRoles(roleKeys: string[], extra?: Permission[]): Promise<{ id: string; cookie: string }>;
  auditRows(action: string): Promise<Array<Record<string, unknown>>>;
}

const open: Array<{ app: FastifyInstance; database: DatabaseHandle }> = [];
afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

async function setup(env: Record<string, string> = {}): Promise<Harness> {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const app = await buildApp({ config, database, logger: false });
  open.push({ app, database });
  const created = await app.services.users.create({
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

  let n = 0;
  const userWith = async (permissions: Permission[]) => {
    n += 1;
    const key = `CUSTOM_${n}`;
    await app.services.authz.createRole({ key, name: key, permissions }, created.id);
    const email = `user${n}@example.com`;
    await app.services.users.create({
      email,
      name: `Pessoa ${n}`,
      password: PASSWORD,
      roles: [key],
    });
    return login(email, PASSWORD);
  };

  const userWithRoles = async (roleKeys: string[], extra: Permission[] = []) => {
    n += 1;
    const keys = [...roleKeys];
    if (extra.length > 0) {
      const key = `SEEDED_${n}`;
      const [r] = await database.db
        .insert(roles)
        .values({ key, name: key, system: false })
        .returning({ id: roles.id });
      await database.db
        .insert(rolePermissions)
        .values(extra.map((permission) => ({ roleId: r!.id, permission })));
      keys.push(key);
    }
    const email = `user${n}@example.com`;
    const user = await app.services.users.create({
      email,
      name: `Pessoa ${n}`,
      password: PASSWORD,
      roles: keys,
    });
    return { id: user.id, cookie: await login(email, PASSWORD) };
  };

  const auditRows = async (action: string) =>
    (await app.services.audit.list({ action, limit: 100, offset: 0 })).items as unknown as Array<
      Record<string, unknown>
    >;

  return {
    app,
    adminId: created.id,
    admin: await login(ADMIN.email, ADMIN.password),
    call,
    userWith,
    userWithRoles,
    auditRows,
  };
}

const codeOf = (res: Response) => (res.json() as { error?: { code: string } }).error?.code;

const POLICY = {
  name: 'Sandbox caps reads',
  effect: 'ALLOW',
  subjectType: 'everyone',
  subjectId: null,
  environments: ['SANDBOX'],
  connectionIds: [],
  actions: ['QUERY.SELECT'],
  entities: ['TGF*'],
  columns: [],
  limits: { maxReadRows: 100 },
  overrideWhereRequired: false,
  enabled: true,
};

describe('admin route permissions', () => {
  it('requires the ADMIN.* permission of each area and nothing else', async () => {
    const h = await setup();
    const usersOnly = await h.userWith(['ADMIN.USERS']);
    const areas: Array<[string, Permission]> = [
      ['/api/admin/policies', 'ADMIN.POLICIES'],
      ['/api/admin/connections', 'ADMIN.CONNECTIONS'],
      ['/api/admin/security', 'ADMIN.SECURITY'],
      ['/api/admin/groups', 'ADMIN.GROUPS'],
      ['/api/admin/roles', 'ADMIN.ROLES'],
    ];
    for (const [url, permission] of areas) {
      expect((await h.call(null, { method: 'GET', url })).statusCode, url).toBe(401);
      const denied = await h.call(usersOnly, { method: 'GET', url });
      expect(denied.statusCode, url).toBe(403);
      expect(denied.json().error.details).toEqual({ permission });
      const holder = await h.userWith([permission]);
      expect((await h.call(holder, { method: 'GET', url })).statusCode, url).toBe(200);
    }
    expect((await h.call(usersOnly, { method: 'GET', url: '/api/admin/users' })).statusCode).toBe(
      200,
    );
  });

  it('refuses a user without ADMIN.POLICIES with 403 on every policy route, changing nothing', async () => {
    const h = await setup();
    const created = await h.app.services.policies.create(POLICY as never);
    const before = (await h.app.services.policies.current()).version;
    const cookie = await h.userWith(['ADMIN.USERS', 'ADMIN.ROLES', 'ADMIN.SECURITY']);
    const attempts: InjectOptions[] = [
      { method: 'GET', url: '/api/admin/policies' },
      { method: 'POST', url: '/api/admin/policies', payload: POLICY },
      { method: 'PATCH', url: `/api/admin/policies/${created.id}`, payload: { enabled: false } },
      { method: 'DELETE', url: `/api/admin/policies/${created.id}` },
    ];
    for (const opts of attempts) {
      const res = await h.call(cookie, opts);
      expect(res.statusCode, `${opts.method} ${opts.url}`).toBe(403);
      expect(codeOf(res)).toBe('FORBIDDEN');
    }
    expect((await h.app.services.policies.current()).version).toBe(before);
    expect(await h.app.services.policies.list()).toHaveLength(1);
  });
});

describe('policies', () => {
  it('creating, updating and deleting a policy changes policyVersion, each change audited', async () => {
    const h = await setup();
    const initial = await h.call(h.admin, { method: 'GET', url: '/api/admin/policies' });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.headers['cache-control']).toContain('no-store');
    const v0 = initial.json().policyVersion as string;
    expect(typeof v0).toBe('string');
    expect(initial.json().items).toEqual([]);

    const created = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/policies',
      payload: POLICY,
    });
    expect(created.statusCode, created.body).toBe(201);
    const item = created.json().item as { id: string; name: string };
    expect(item.name).toBe(POLICY.name);
    const v1 = created.json().policyVersion as string;
    expect(v1).not.toBe(v0);

    const listed = await h.call(h.admin, { method: 'GET', url: '/api/admin/policies' });
    expect(listed.json().policyVersion).toBe(v1);
    expect(listed.json().items.map((p: { id: string }) => p.id)).toEqual([item.id]);
    expect(listed.json().invalid).toEqual([]);

    const updated = await h.call(h.admin, {
      method: 'PATCH',
      url: `/api/admin/policies/${item.id}`,
      payload: { limits: { maxReadRows: 50 } },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const v2 = updated.json().policyVersion as string;
    expect(v2).not.toBe(v1);

    const deleted = await h.call(h.admin, {
      method: 'DELETE',
      url: `/api/admin/policies/${item.id}`,
    });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().policyVersion).toBe(v0);

    for (const action of ['policy.create', 'policy.update', 'policy.delete']) {
      const rows = await h.auditRows(action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'success', userId: h.adminId });
    }
    expect((await h.auditRows('policy.create'))[0]!.details).toMatchObject({
      policyId: item.id,
      policyVersion: v1,
    });
  });

  it('rejects an invalid rule and unknown fields with VALIDATION_ERROR, saving nothing', async () => {
    const h = await setup();
    const bad = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/policies',
      payload: { ...POLICY, actions: ['NOT.A_PERMISSION'] },
    });
    expect(bad.statusCode).toBe(400);
    expect(codeOf(bad)).toBe('VALIDATION_ERROR');
    const extra = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/policies',
      payload: { ...POLICY, id: '00000000-0000-4000-8000-000000000001' },
    });
    expect(extra.statusCode).toBe(400);
    expect(await h.app.services.policies.list()).toEqual([]);
  });
});

describe('policies: separation of duties', () => {
  const policyChanges = (id: string): InjectOptions[] => [
    { method: 'POST', url: '/api/admin/policies', payload: POLICY },
    { method: 'PATCH', url: `/api/admin/policies/${id}`, payload: { enabled: false } },
    { method: 'DELETE', url: `/api/admin/policies/${id}` },
  ];

  it('refuses and audits every policy change by an ADMIN that also holds OPERATOR', async () => {
    const h = await setup();
    const existing = await h.app.services.policies.create(POLICY as never);
    const before = (await h.app.services.policies.current()).version;
    const mixed = await h.userWithRoles(['ADMIN', 'OPERATOR']);
    for (const opts of policyChanges(existing.id)) {
      const res = await h.call(mixed.cookie, opts);
      expect(res.statusCode, `${opts.method} ${opts.url}`).toBe(403);
      expect(codeOf(res)).toBe('FORBIDDEN');
      expect(res.json().error.details).toEqual({
        reason: 'separation_of_duties',
        conflicting: ['DATA.INSERT', 'DATA.UPDATE'],
      });
    }
    // Nothing changed, and reading the rules is still allowed.
    expect((await h.app.services.policies.current()).version).toBe(before);
    expect(await h.app.services.policies.list()).toHaveLength(1);
    const listed = await h.call(mixed.cookie, { method: 'GET', url: '/api/admin/policies' });
    expect(listed.statusCode).toBe(200);

    for (const action of ['policy.create', 'policy.update', 'policy.delete']) {
      const rows = await h.auditRows(action);
      expect(rows, action).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'denied', userId: mixed.id, errorCode: 'FORBIDDEN' });
    }
  });

  it.each([
    'DATA.INSERT',
    'DATA.UPDATE',
    'DATA.DELETE',
    'DDL.CUSTOM.GENERATE',
    'SANKHYA.BUSINESS_ACTION.EXECUTE',
  ] as const)('refuses a policy change by an ADMIN that also holds %s', async (permission) => {
    const h = await setup();
    const actor = await h.userWithRoles(['ADMIN'], [permission]);
    const res = await h.call(actor.cookie, {
      method: 'POST',
      url: '/api/admin/policies',
      payload: POLICY,
    });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.details).toEqual({
      reason: 'separation_of_duties',
      conflicting: [permission],
    });
    expect(await h.app.services.policies.list()).toEqual([]);
  });

  it('lets a plain ADMIN change policies, and still refuses them granting themselves OPERATOR', async () => {
    const h = await setup();
    const created = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/policies',
      payload: POLICY,
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id as string;
    for (const opts of policyChanges(id).slice(1)) {
      const res = await h.call(h.admin, opts);
      expect(res.statusCode, `${opts.method} ${opts.url} ${res.body}`).toBe(200);
    }

    // The admin cannot turn themselves into a dual-role account: not directly, and not through
    // a group carrying OPERATOR (a role they do not hold).
    const self = await h.call(h.admin, {
      method: 'PUT',
      url: `/api/admin/users/${h.adminId}/roles`,
      payload: { roles: ['ADMIN', 'OPERATOR'] },
    });
    expect(self.statusCode).toBe(403);
    expect(self.json().error.details).toMatchObject({ reason: 'self_change' });
    const group = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/groups',
      payload: { name: 'Operação' },
    });
    const gid = group.json().item.id as string;
    const viaGroup = await h.call(h.admin, {
      method: 'PUT',
      url: `/api/admin/groups/${gid}/roles`,
      payload: { roles: ['OPERATOR'] },
    });
    expect(viaGroup.statusCode).toBe(403);
    expect(viaGroup.json().error.details).toMatchObject({
      reason: 'beyond_own',
      missing: ['DATA.INSERT', 'DATA.UPDATE'],
    });
    const me = await h.call(h.admin, { method: 'GET', url: '/api/auth/me' });
    expect(me.json().user.permissions).not.toContain('DATA.UPDATE');
  });
});

describe('connections', () => {
  it('masks secrets in every response and audit row; the env connection is read-only', async () => {
    const h = await setup();
    const created = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/connections',
      payload: {
        name: 'Homologacao',
        environment: 'HOMOLOGATION',
        mode: 'mock',
        baseUrl: MOCK_BASE_URL,
        dialect: 'oracle',
        secrets: SECRETS,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().item.id as string;
    expect(created.json().item).toMatchObject({
      source: 'database',
      editable: true,
      status: 'READY',
      secrets: { clientId: 'stor…6789', clientSecret: 'SET', xToken: 'SET' },
    });

    const list = await h.call(h.admin, { method: 'GET', url: '/api/admin/connections' });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.headers['cache-control']).toContain('no-store');
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items.map((c) => [c.id, c.editable])).toEqual([
      ['env-default', false],
      [id, true],
    ]);
    expect(items[0]).toMatchObject({
      source: 'env',
      secrets: { clientSecret: 'SET', xToken: 'SET' },
    });

    const rotated = await h.call(h.admin, {
      method: 'PUT',
      url: `/api/admin/connections/${id}/secrets`,
      payload: ROTATED,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().item.secretsRotatedAt).not.toBeNull();

    const patched = await h.call(h.admin, {
      method: 'PATCH',
      url: `/api/admin/connections/${id}`,
      payload: { name: 'Homologacao 2' },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().item.name).toBe('Homologacao 2');

    const tested = await h.call(h.admin, {
      method: 'POST',
      url: '/api/admin/connections/env-default/test',
    });
    expect(tested.statusCode, tested.body).toBe(200);
    expect(tested.json()).toMatchObject({ ok: true });

    const one = await h.call(h.admin, { method: 'GET', url: `/api/admin/connections/${id}` });
    expect(one.statusCode).toBe(200);

    for (const res of [created, list, rotated, patched, tested, one]) {
      for (const secret of [
        ...Object.values(SECRETS),
        ...Object.values(ROTATED),
        MOCK_CREDENTIALS.clientId,
        MOCK_CREDENTIALS.clientSecret,
        MOCK_CREDENTIALS.xToken,
      ]) {
        expect(res.body).not.toContain(secret);
      }
    }

    // The env connection cannot be edited, rotated or deleted, and the refusal is audited.
    for (const opts of [
      { method: 'PATCH', url: '/api/admin/connections/env-default', payload: { name: 'x' } },
      { method: 'PUT', url: '/api/admin/connections/env-default/secrets', payload: ROTATED },
      { method: 'DELETE', url: '/api/admin/connections/env-default' },
    ] as InjectOptions[]) {
      const res = await h.call(h.admin, opts);
      expect(res.statusCode, `${opts.method} ${opts.url}`).toBe(403);
    }
    expect(await h.auditRows('connection.update')).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'denied' })]),
    );

    const removed = await h.call(h.admin, {
      method: 'DELETE',
      url: `/api/admin/connections/${id}`,
    });
    expect(removed.statusCode, removed.body).toBe(200);

    const audit = await h.app.services.audit.list({ limit: 200, offset: 0 });
    const connectionRows = audit.items.filter((r) => r.action.startsWith('connection.'));
    expect(connectionRows.map((r) => `${r.action}:${r.status}`)).toEqual(
      expect.arrayContaining([
        'connection.create:success',
        'connection.rotate_secrets:success',
        'connection.update:success',
        'connection.test:success',
        'connection.delete:success',
      ]),
    );
    const dump = JSON.stringify(audit.items);
    for (const secret of [...Object.values(SECRETS), ...Object.values(ROTATED)])
      expect(dump).not.toContain(secret);
    const rotations = await h.auditRows('connection.rotate_secrets');
    expect(rotations.find((r) => r.status === 'success')!.details).toEqual({
      connectionId: id,
      fields: ['clientSecret'],
    });
    expect(rotations.find((r) => r.status === 'denied')!.details).toEqual({
      connectionId: 'env-default',
      fields: ['clientSecret'],
    });
  });

  it('refuses a user without ADMIN.CONNECTIONS', async () => {
    const h = await setup();
    const cookie = await h.userWith(['ADMIN.POLICIES']);
    const res = await h.call(cookie, {
      method: 'POST',
      url: '/api/admin/connections',
      payload: {
        name: 'X',
        environment: 'SANDBOX',
        mode: 'mock',
        baseUrl: MOCK_BASE_URL,
        dialect: 'oracle',
      },
    });
    expect(res.statusCode).toBe(403);
    expect((await h.app.services.connections.list()).map((c) => c.id)).toEqual(['env-default']);
  });
});

describe('security kill switch', () => {
  it('cannot enable writes when the env is off: the effective value stays false, both reported', async () => {
    const h = await setup(); // GLOBAL_WRITE_ENABLED defaults to false
    const initial = await h.call(h.admin, { method: 'GET', url: '/api/admin/security' });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.headers['cache-control']).toContain('no-store');
    expect(initial.json()).toEqual({
      globalWriteEnabled: { env: false, runtime: true, effective: false },
    });

    const put = await h.call(h.admin, {
      method: 'PUT',
      url: '/api/admin/security',
      payload: { globalWriteEnabled: true },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({
      globalWriteEnabled: { env: false, runtime: true, effective: false },
    });
    expect(await h.app.services.security.globalWriteState()).toEqual({
      env: false,
      runtime: true,
      effective: false,
    });
  });

  it('turns writes off at runtime when the env allows them, and back on; every change audited', async () => {
    const h = await setup({ GLOBAL_WRITE_ENABLED: 'true' });
    const initial = await h.call(h.admin, { method: 'GET', url: '/api/admin/security' });
    expect(initial.json().globalWriteEnabled).toEqual({
      env: true,
      runtime: true,
      effective: true,
    });

    const off = await h.call(h.admin, {
      method: 'PUT',
      url: '/api/admin/security',
      payload: { globalWriteEnabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().globalWriteEnabled).toEqual({ env: true, runtime: false, effective: false });
    expect((await h.app.services.security.globalWriteState()).effective).toBe(false);

    const on = await h.call(h.admin, {
      method: 'PUT',
      url: '/api/admin/security',
      payload: { globalWriteEnabled: true },
    });
    expect(on.json().globalWriteEnabled).toEqual({ env: true, runtime: true, effective: true });

    const rows = await h.auditRows('security.update');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.details)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          setting: 'globalWriteEnabled',
          from: true,
          to: false,
          env: true,
          effective: false,
        }),
        expect.objectContaining({ from: false, to: true, effective: true }),
      ]),
    );
  });

  it('requires ADMIN.SECURITY and rejects anything but a boolean', async () => {
    const h = await setup({ GLOBAL_WRITE_ENABLED: 'true' });
    const cookie = await h.userWith(['ADMIN.POLICIES', 'ADMIN.CONNECTIONS']);
    const denied = await h.call(cookie, {
      method: 'PUT',
      url: '/api/admin/security',
      payload: { globalWriteEnabled: false },
    });
    expect(denied.statusCode).toBe(403);
    expect((await h.app.services.security.globalWriteState()).effective).toBe(true);
    for (const payload of [
      {},
      { globalWriteEnabled: 'false' },
      { globalWriteEnabled: false, x: 1 },
    ]) {
      const res = await h.call(h.admin, { method: 'PUT', url: '/api/admin/security', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});
