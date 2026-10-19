import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createMockSankhya } from '@dbx/sankhya-client/mock';
import { isAppError } from '@dbx/shared';
import { loadConfig } from '../config';
import { ConnectionsService, ENV_CONNECTION_ID } from './connections';
import type { ConnectionsDeps, CreateConnectionInput } from './connections';

// Fictitious credentials and hosts, used only by these tests.
const SECRETS = {
  clientId: 'client-id-fixture-0123456789',
  clientSecret: 'client-secret-fixture-value-zz',
  xToken: 'x-token-fixture-value-qq',
};
const ALLOWED_HOST = 'gateway.example.com';
const ENV_SECRETS = {
  SANKHYA_BASE_URL: `https://${ALLOWED_HOST}`,
  SANKHYA_CLIENT_ID: 'env-client-id-fixture-abcdef',
  SANKHYA_CLIENT_SECRET: 'env-client-secret-fixture-value',
  SANKHYA_X_TOKEN: 'env-x-token-fixture-value',
};
const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'pglite:memory',
  LOG_LEVEL: 'silent',
  SANKHYA_ALLOWED_HOSTS: ALLOWED_HOST,
};
const PUBLIC_DNS: ConnectionsDeps['resolve'] = () => Promise.resolve(['203.0.113.10']);

const MOCK_INPUT: CreateConnectionInput = {
  name: 'Demo',
  environment: 'SANDBOX',
  mode: 'mock',
  baseUrl: 'mock://local',
  dialect: 'oracle',
  secrets: SECRETS,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(env: Record<string, string> = {}, deps: ConnectionsDeps = {}) {
  const config = loadConfig({ ...BASE_ENV, ...env });
  const database: DatabaseHandle = await createDatabase(config.databaseUrl);
  await database.migrate();
  cleanup.push(() => database.close());
  const service = new ConnectionsService(database.db, config, {
    resolve: PUBLIC_DNS,
    // The real fictitious gateway, accepting the fixture credentials above.
    mockGateway: () => createMockSankhya({ seed: 7, ...SECRETS }),
    ...deps,
  });
  cleanup.push(() => service.close());
  const rows = async () => {
    const r = (await database.db.execute(sql`select * from connections`)) as unknown as
      { rows: Record<string, unknown>[] } | Record<string, unknown>[];
    return Array.isArray(r) ? r : r.rows;
  };
  return { service, rows };
}

async function codeOf(promise: Promise<unknown>) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return isAppError(err) ? err.code : err;
}

describe('ConnectionsService', () => {
  it('lists the env connection masked, defaults it to PRODUCTION and never stores it', async () => {
    const { service, rows } = await setup(ENV_SECRETS);
    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: ENV_CONNECTION_ID,
      source: 'env',
      environment: 'PRODUCTION',
      baseUrl: `https://${ALLOWED_HOST}`,
      secrets: { clientId: 'env-…cdef', clientSecret: 'SET', xToken: 'SET' },
    });
    const json = JSON.stringify(list);
    for (const value of Object.values(ENV_SECRETS).slice(1)) expect(json).not.toContain(value);
    expect(await rows()).toHaveLength(0);
    expect(await codeOf(service.update(ENV_CONNECTION_ID, { name: 'x' }))).toBe('FORBIDDEN');
    expect(await codeOf(service.rotateSecrets(ENV_CONNECTION_ID, { xToken: 'y' }))).toBe(
      'FORBIDDEN',
    );
    // Still nothing persisted after the refused edits.
    expect(await rows()).toHaveLength(0);
  });

  it('takes the env connection environment from SANKHYA_ENVIRONMENT', async () => {
    const { service } = await setup({ ...ENV_SECRETS, SANKHYA_ENVIRONMENT: 'HOMOLOGATION' });
    expect((await service.list())[0]!.environment).toBe('HOMOLOGATION');
  });

  it('reports NOT_SET secrets and NOT_CONFIGURED without credentials', async () => {
    const { service } = await setup();
    expect(await service.list()).toEqual([]);
    const created = await service.create({
      ...MOCK_INPUT,
      secrets: { clientId: SECRETS.clientId },
    });
    expect(created.secrets).toEqual({
      clientId: 'clie…6789',
      clientSecret: 'NOT_SET',
      xToken: 'NOT_SET',
    });
    expect(await service.test(created.id)).toMatchObject({
      ok: false,
      errorCode: 'SANKHYA_NOT_CONFIGURED',
    });
  });

  it('stores ciphertext only', async () => {
    const { service, rows } = await setup();
    await service.create(MOCK_INPUT);
    const [row] = await rows();
    const raw = JSON.stringify(row);
    for (const value of Object.values(SECRETS)) expect(raw).not.toContain(value);
    expect(row!.client_id_enc).toMatch(/^v1\./);
    expect(row!.client_secret_enc).toMatch(/^v1\./);
    expect(row!.x_token_enc).toMatch(/^v1\./);
  });

  it('list() never returns secret values', async () => {
    const { service } = await setup();
    const created = await service.create(MOCK_INPUT);
    const list = await service.list();
    const json = JSON.stringify(list);
    expect(json).not.toContain(SECRETS.clientSecret);
    expect(json).not.toContain(SECRETS.xToken);
    expect(json).not.toContain(SECRETS.clientId);
    expect(list[0]).toMatchObject({
      id: created.id,
      environment: 'SANDBOX',
      secrets: { clientId: 'clie…6789', clientSecret: 'SET', xToken: 'SET' },
    });
    expect(list[0]!.secretsRotatedAt).not.toBeNull();
  });

  it('rotation re-encrypts the secrets and replaces the cached runtime', async () => {
    const { service, rows } = await setup();
    const { id } = await service.create(MOCK_INPUT);
    const before = await service.getRuntime(id);
    expect(await service.getRuntime(id)).toBe(before);
    const [oldRow] = await rows();
    await service.rotateSecrets(id, { clientSecret: 'replaced-secret-fixture-value' });
    const [newRow] = await rows();
    expect(newRow!.client_secret_enc).not.toBe(oldRow!.client_secret_enc);
    expect(newRow!.x_token_enc).toBe(oldRow!.x_token_enc);
    const after = await service.getRuntime(id);
    expect(after).not.toBe(before);
    await service.update(id, { environment: 'HOMOLOGATION' });
    const updated = await service.getRuntime(id);
    expect(updated).not.toBe(after);
    expect(updated.environment).toBe('HOMOLOGATION');
    expect(await codeOf(service.rotateSecrets(id, {}))).toBe('VALIDATION_ERROR');
  });

  it('rejects non-allowlisted base URLs', async () => {
    const { service } = await setup({}, { resolve: () => Promise.reject(new Error('no DNS')) });
    const live = { ...MOCK_INPUT, mode: 'live' as const };
    expect(await codeOf(service.create({ ...live, baseUrl: 'https://other.example.org' }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      await codeOf(service.create({ ...MOCK_INPUT, baseUrl: 'https://other.example.org' })),
    ).toBe('VALIDATION_ERROR');
    // The mock literal is for mock connections only.
    expect(await codeOf(service.create({ ...live, baseUrl: 'mock://local' }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(
      await codeOf(service.create({ ...MOCK_INPUT, baseUrl: `https://${ALLOWED_HOST}/x` })),
    ).toBe('VALIDATION_ERROR');
    // Mock mode skips DNS (the resolver above always fails) but keeps the allowlist.
    const mock = await service.create({
      ...MOCK_INPUT,
      baseUrl: `https://${ALLOWED_HOST.toUpperCase()}/`,
    });
    expect(mock.baseUrl).toBe(`https://${ALLOWED_HOST}`);
    // Live mode resolves the host: a failing resolver rejects it.
    expect(
      await codeOf(service.create({ ...live, name: 'Live', baseUrl: `https://${ALLOWED_HOST}` })),
    ).toBe('VALIDATION_ERROR');
    expect(await codeOf(service.create({ ...MOCK_INPUT, name: ENV_CONNECTION_ID }))).toBe(
      'VALIDATION_ERROR',
    );
    expect(await codeOf(service.create({ ...MOCK_INPUT, name: 'Demo' }))).toBe('CONFLICT');
  });

  it('refuses mock connections when SANKHYA_MODE=live', async () => {
    const { service } = await setup({ SANKHYA_MODE: 'live' });
    expect(await codeOf(service.create(MOCK_INPUT))).toBe('VALIDATION_ERROR');
  });

  it('test() against the mock gateway returns ok', async () => {
    const { service } = await setup();
    const { id } = await service.create(MOCK_INPUT);
    const result = await service.test(id);
    expect(result).toEqual({ ok: true, latencyMs: expect.any(Number) as number });
    expect(await codeOf(service.test('00000000-0000-4000-8000-000000000000'))).toBe('NOT_FOUND');
  });

  it('test() reports wrong credentials without leaking them', async () => {
    const { service } = await setup();
    const wrong = { ...SECRETS, clientSecret: 'wrong-secret-fixture-value' };
    const { id } = await service.create({ ...MOCK_INPUT, secrets: wrong });
    const result = await service.test(id);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toMatch(/^SANKHYA_/);
    expect(JSON.stringify(result)).not.toContain(wrong.clientSecret);
  });

  it('test() on a live connection authenticates with the decrypted credentials', async () => {
    const seen: string[] = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(new URL(url).pathname);
      if (url.endsWith('/authenticate')) {
        const headers = new Headers(init?.headers);
        const body = new URLSearchParams(String(init?.body));
        const ok =
          headers.get('x-token') === SECRETS.xToken &&
          body.get('client_id') === SECRETS.clientId &&
          body.get('client_secret') === SECRETS.clientSecret;
        return Response.json(ok ? { access_token: 'tok', expires_in: 300 } : {}, {
          status: ok ? 200 : 401,
        });
      }
      return Response.json({
        status: '1',
        responseBody: { fieldsMetadata: [{ name: 'OK' }], rows: [[1]] },
      });
    }) as typeof fetch;
    const { service } = await setup({ SANKHYA_MODE: 'live' }, { fetch: fakeFetch });
    const { id } = await service.create({
      ...MOCK_INPUT,
      mode: 'live',
      baseUrl: `https://${ALLOWED_HOST}`,
    });
    expect(await service.test(id)).toMatchObject({ ok: true });
    expect(seen).toEqual(['/authenticate', '/gateway/v1/mge/service.sbr']);
  });
});
