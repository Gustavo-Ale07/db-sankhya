import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, createDatabase, metadataCache } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createMockSankhya } from '@dbx/sankhya-client/mock';
import { isAppError } from '@dbx/shared';
import { loadConfig } from '../config';
import { ConnectionsService } from './connections';
import { DEGRADED_TTL_MS, METADATA_TTL_MS, MetadataService } from './metadata';

// Fictitious credentials, used only by these tests.
const SECRETS = {
  clientId: 'client-id-fixture-0123456789',
  clientSecret: 'client-secret-fixture-value-zz',
  xToken: 'x-token-fixture-value-qq',
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(opts: { dialect?: 'oracle' | 'mssql'; queryRowCap?: number } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  });
  const database: DatabaseHandle = await createDatabase(config.databaseUrl);
  await database.migrate();
  cleanup.push(() => database.close());
  const mock = await createMockSankhya({
    seed: 7,
    ...SECRETS,
    ...(opts.queryRowCap ? { queryRowCap: opts.queryRowCap } : {}),
  });
  const conns = new ConnectionsService(database.db, config, {
    resolve: () => Promise.resolve(['203.0.113.10']),
    mockGateway: () => Promise.resolve(mock),
  });
  cleanup.push(() => conns.close());
  const conn = await conns.create({
    name: 'Demo',
    environment: 'SANDBOX',
    mode: 'mock',
    baseUrl: 'mock://local',
    dialect: opts.dialect ?? 'oracle',
    secrets: SECRETS,
  });
  let clock = Date.UTC(2026, 0, 1);
  const service = (db = database.db) =>
    new MetadataService(db, { getRuntime: (id) => conns.getRuntime(id), now: () => clock });
  return {
    database,
    mock,
    conn,
    service,
    advance: (ms: number) => (clock += ms),
  };
}

const queries = (mock: { calls: Array<{ serviceName: string }> }) =>
  mock.calls.filter((c) => c.serviceName === 'DbExplorerSP.executeQuery').length;

describe('MetadataService', () => {
  it('builds the catalog from the dictionary with primary keys and entities', async () => {
    const { service, conn } = await setup();
    const catalog = await service().get(conn.id);

    expect(catalog.source).toBe('dictionary');
    expect(Number.isNaN(Date.parse(catalog.fetchedAt))).toBe(false);
    const par = catalog.tables.find((t) => t.name === 'TGFPAR');
    expect(par?.entityName).toBe('Parceiro');
    expect(par?.description).toBe('Parceiros (demo)');
    const codparc = par?.columns.find((c) => c.name === 'CODPARC');
    expect(codparc).toMatchObject({ type: 'integer', pk: true });
    expect(par?.columns.find((c) => c.name === 'NOMEPARC')).toMatchObject({
      type: 'string',
      pk: false,
    });
    const ite = catalog.tables.find((t) => t.name === 'TGFITE');
    expect(
      ite?.columns
        .filter((c) => c.pk)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['NUNOTA', 'SEQUENCIA']);
    expect(par?.foreignKeys).toEqual([]);
  });

  it('serves a second get within the TTL without calling the gateway', async () => {
    const { service, conn, mock, advance } = await setup();
    const svc = service();
    await svc.get(conn.id);
    const before = mock.calls.length;
    advance(METADATA_TTL_MS - 1);
    await svc.get(conn.id);
    expect(mock.calls.length).toBe(before);
  });

  it('re-fetches after the TTL expires', async () => {
    const { service, conn, mock, advance } = await setup();
    const svc = service();
    await svc.get(conn.id);
    const before = queries(mock);
    advance(METADATA_TTL_MS);
    const again = await svc.get(conn.id);
    expect(queries(mock)).toBeGreaterThan(before);
    expect(Date.parse(again.fetchedAt)).toBeGreaterThan(Date.UTC(2026, 0, 1));
  });

  it('re-fetches when refresh is true', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    await svc.get(conn.id);
    const before = queries(mock);
    await svc.get(conn.id, { refresh: true });
    expect(queries(mock)).toBeGreaterThan(before);
  });

  it('shares one discovery between concurrent callers', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    await Promise.all([svc.get(conn.id), svc.get(conn.id), svc.get(conn.id)]);
    expect(queries(mock)).toBe(4);
  });

  it('returns tables without columns when the TDDCAM query fails', async () => {
    const { service, conn, mock } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const catalog = await service().get(conn.id);

    expect(catalog.tables.length).toBeGreaterThan(0);
    expect(catalog.tables.every((t) => t.columns.length === 0)).toBe(true);
    expect(catalog.tables.find((t) => t.name === 'TGFPAR')?.entityName).toBe('Parceiro');
  });

  it('keeps columns but drops entities and marks the catalog degraded when TDDINS fails', async () => {
    const { service, conn, mock } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDINS' });
    const catalog = await service().get(conn.id);
    const par = catalog.tables.find((t) => t.name === 'TGFPAR');
    expect(par?.entityName).toBeUndefined();
    expect(par?.columns.length).toBeGreaterThan(0);
    expect(catalog.degraded).toEqual(['TDDINS:failed']);
  });

  it.each([
    ['oracle', 'ALL_CONS_COLUMNS'],
    ['mssql', 'KEY_COLUMN_USAGE'],
  ] as const)('discovers primary keys through the %s catalog views', async (dialect, view) => {
    const { service, conn, mock } = await setup({ dialect });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toBeUndefined();
    const par = catalog.tables.find((t) => t.name === 'TGFPAR');
    expect(par?.columns.filter((c) => c.pk).map((c) => c.name)).toEqual(['CODPARC']);
    const est = catalog.tables.find((t) => t.name === 'TGFEST');
    expect(
      est?.columns
        .filter((c) => c.pk)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['CODEMP', 'CODLOCAL', 'CODPROD']);

    // The same catalog query failing leaves pk false and marks the catalog degraded.
    mock.inject({ type: 'malformed' }, { sqlIncludes: view });
    const failed = await service().get(conn.id, { refresh: true });
    expect(failed.tables.every((t) => t.columns.every((c) => !c.pk))).toBe(true);
    expect(failed.tables.find((t) => t.name === 'TGFPAR')?.columns.length).toBeGreaterThan(0);
    expect(failed.degraded).toEqual(['PK:failed']);
  });

  it('keeps a degraded catalog in memory for 60 s only and never persists it', async () => {
    const { service, conn, mock, database, advance } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const svc = service();
    const degraded = await svc.get(conn.id);
    expect(degraded.degraded).toEqual(['TDDCAM:failed']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);

    advance(DEGRADED_TTL_MS - 1);
    const before = mock.calls.length;
    expect(await svc.get(conn.id)).toBe(degraded);
    expect(mock.calls.length).toBe(before);

    // After the short expiry the next lookup rediscovers and, now complete, persists.
    advance(1);
    const healed = await svc.get(conn.id);
    expect(healed.degraded).toBeUndefined();
    expect(healed.tables.find((t) => t.name === 'TGFPAR')?.columns.length).toBeGreaterThan(0);
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);
  });

  it('marks truncated reads as degraded and keeps the partial tables', async () => {
    const { service, conn, database } = await setup({ queryRowCap: 3 });
    const catalog = await service().get(conn.id);
    expect(catalog.tables).toHaveLength(3);
    expect(catalog.degraded).toEqual(
      expect.arrayContaining(['TDDTAB:truncated', 'TDDCAM:truncated', 'PK:truncated']),
    );
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });

  it('invalidate drops the memory and persisted catalog, forcing rediscovery', async () => {
    const { service, conn, mock, database } = await setup();
    const svc = service();
    await svc.get(conn.id);
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);

    await svc.invalidate(conn.id);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
    const before = queries(mock);
    await svc.get(conn.id);
    expect(queries(mock)).toBeGreaterThan(before);
    // A second instance sharing the database no longer finds the old row either.
    await svc.invalidate(conn.id);
    const other = service();
    const again = queries(mock);
    await other.get(conn.id);
    expect(queries(mock)).toBeGreaterThan(again);
  });

  it('fails with SANKHYA_API_ERROR when the tables query fails, and caches nothing', async () => {
    const { service, conn, mock, database } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDTAB' });
    const svc = service();
    const err = await svc.get(conn.id).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isAppError(err) && err.code).toBe('SANKHYA_API_ERROR');
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
    // The failure is not cached: the next call discovers normally.
    expect((await svc.get(conn.id)).tables.length).toBeGreaterThan(0);
  });

  it('persists the catalog so a new service instance reuses it', async () => {
    const { service, conn, mock } = await setup();
    const first = await service().get(conn.id);
    const before = mock.calls.length;
    const second = await service().get(conn.id);
    expect(mock.calls.length).toBe(before);
    expect(second).toEqual(first);
  });

  it('drops the cached catalog together with its connection', async () => {
    const { service, conn, database } = await setup();
    await service().get(conn.id);
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);
    await database.db.delete(connections).where(eq(connections.id, conn.id));
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });
});
