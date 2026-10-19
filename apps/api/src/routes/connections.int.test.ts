import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { MOCK_CREDENTIALS } from '@dbx/sankhya-client/mock';
import { buildApp } from '../app';
import { loadConfig } from '../config';
import { MOCK_BASE_URL } from '../services/sankhya-runtime';

const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'User!Strong#Pass9';

const BASE_ENV = {
  NODE_ENV: 'test',
  APP_URL: ORIGIN,
  DATABASE_URL: 'pglite:memory',
  SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
  LOG_LEVEL: 'silent',
  SANKHYA_MODE: 'mock',
  SANKHYA_BASE_URL: 'https://gateway.example.com',
  SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  SANKHYA_CLIENT_ID: MOCK_CREDENTIALS.clientId,
  SANKHYA_CLIENT_SECRET: MOCK_CREDENTIALS.clientSecret,
  SANKHYA_X_TOKEN: MOCK_CREDENTIALS.xToken,
  SANKHYA_DIALECT: 'oracle',
};

const SECRETS = {
  clientId: 'stored-client-id-0123456789',
  clientSecret: 'stored-client-secret-value',
  xToken: 'stored-x-token-value',
};

const open: Array<{ app: FastifyInstance; database: DatabaseHandle }> = [];

async function setup(env: Record<string, string> = {}) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database = await createDatabase(config.databaseUrl);
  await database.migrate();
  const app = await buildApp({ config, database });
  open.push({ app, database });
  let n = 0;
  const login = async (roles: string[]) => {
    const email = `user${++n}@example.com`;
    await app.services.users.create({ email, name: 'Pessoa', password: PASSWORD, roles });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: PASSWORD },
    });
    return res.cookies.find((c) => c.name === config.session.cookieName)!.value;
  };
  const get = (cookie: string | null) =>
    app.inject({
      method: 'GET',
      url: '/api/connections',
      headers: cookie ? { cookie: `${config.session.cookieName}=${cookie}` } : {},
    });
  return { app, login, get };
}

afterEach(async () => {
  while (open.length) {
    const h = open.pop()!;
    await h.app.close();
    await h.database.close();
  }
});

describe('GET /api/connections', () => {
  it('requires a session and QUERY.SELECT', async () => {
    const h = await setup();
    expect((await h.get(null)).statusCode).toBe(401);
    const nobody = await h.login([]);
    expect((await h.get(nobody)).statusCode).toBe(403);
  });

  it('lists usable connections with only safe fields, env default included', async () => {
    const h = await setup();
    const created = await h.app.services.connections.create({
      name: 'Homologacao',
      environment: 'HOMOLOGATION',
      mode: 'mock',
      baseUrl: MOCK_BASE_URL,
      dialect: 'oracle',
      secrets: SECRETS,
    });
    await h.app.services.connections.create({
      name: 'Sem credenciais',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: MOCK_BASE_URL,
      dialect: 'oracle',
    });
    const cookie = await h.login(['VIEWER']);
    const res = await h.get(cookie);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items.map((i) => i.name)).toEqual(['env-default', 'Homologacao']);
    expect(items[0]).toEqual({
      id: 'env-default',
      name: 'env-default',
      environment: expect.any(String),
    });
    expect(items[1]).toEqual({ id: created.id, name: 'Homologacao', environment: 'HOMOLOGATION' });
    for (const secret of [...Object.values(SECRETS), ...Object.values(MOCK_CREDENTIALS)])
      expect(res.body).not.toContain(secret);
    expect(res.body).not.toMatch(/baseUrl|gateway\.example|secret|token/i);
  });

  it('lists nothing without an env connection and no stored ones', async () => {
    const h = await setup({ SANKHYA_BASE_URL: '', SANKHYA_CLIENT_ID: '' });
    expect(h.app.services.config.sankhya.envConnection).toBeUndefined();
    const res = await h.get(await h.login(['VIEWER']));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().items).toEqual([]);
  });
});
