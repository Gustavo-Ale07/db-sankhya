import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { buildApp } from './app';
import { loadConfig } from './config';

const ORIGIN = 'http://localhost:5173';

let app: FastifyInstance | undefined;
let database: DatabaseHandle | undefined;

async function setup() {
  const config = loadConfig({
    NODE_ENV: 'test',
    APP_URL: ORIGIN,
    DATABASE_URL: 'pglite:memory',
    SESSION_SECRET: 'integration-test-secret-7Hq2Lm9Xc4Vb8Nz1Kp5Rt3Wy6',
    LOG_LEVEL: 'silent',
    SANKHYA_MODE: 'mock',
  });
  database = await createDatabase(config.databaseUrl);
  await database.migrate();
  app = await buildApp({ config, database, logger: false });
  return { app, database };
}

afterEach(async () => {
  await app?.close().catch(() => {});
  await database?.close().catch(() => {});
  app = undefined;
  database = undefined;
});

describe('health probes', () => {
  it('ready fails closed with 503 and leaks no internals when the database is down', async () => {
    const { app: a, database: db } = await setup();
    vi.spyOn(db, 'ping').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'),
    );
    const res = await a.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error', checks: { database: 'error' } });
    expect(res.body).not.toMatch(/ECONNREFUSED|hunter2|10\.0\.0\.5/);
  });

  it('live and ready expose only status data', async () => {
    const { app: a } = await setup();
    const live = await a.inject({ method: 'GET', url: '/health/live' });
    expect(live.json()).toEqual({ status: 'ok' });
    const ready = await a.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });
});

describe('CORS', () => {
  it('gives no permissive CORS headers to a cross-origin request or preflight', async () => {
    const { app: a } = await setup();
    const evil = 'https://evil.example.org';
    const preflight = await a.inject({
      method: 'OPTIONS',
      url: '/api/query',
      headers: {
        origin: evil,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    const simple = await a.inject({ method: 'GET', url: '/api/meta', headers: { origin: evil } });
    for (const res of [preflight, simple]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBeUndefined();
    }
  });
});

describe('graceful close', () => {
  it('closes the scratch workspaces on app.close()', async () => {
    const { app: a } = await setup();
    const closeAll = vi.fn(async () => {});
    a.services.scratch = { closeAll };
    await a.close();
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
