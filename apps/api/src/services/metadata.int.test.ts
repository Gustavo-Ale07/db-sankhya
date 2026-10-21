import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, createDatabase, metadataCache } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createMockSankhya } from '@dbx/sankhya-client/mock';
import { isAppError } from '@dbx/shared';
import { loadConfig } from '../config';
import { ConnectionsService } from './connections';
import { DEGRADED_TTL_MS, METADATA_TTL_MS, MetadataService, TABLE_TTL_MS } from './metadata';

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

async function setup(
  opts: { dialect?: 'oracle' | 'mssql'; queryRowCap?: number; dictionaryPadding?: number } = {},
) {
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
    ...(opts.dictionaryPadding ? { dictionaryPadding: opts.dictionaryPadding } : {}),
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
    conns,
    conn,
    service,
    advance: (ms: number) => (clock += ms),
  };
}

const queries = (mock: { calls: Array<{ serviceName: string }> }) =>
  mock.calls.filter((c) => c.serviceName === 'DbExplorerSP.executeQuery').length;

/** The SQL of every executeQuery call, in order. */
const sqls = (mock: { calls: Array<{ serviceName: string; requestBody?: unknown }> }) =>
  mock.calls
    .filter((c) => c.serviceName === 'DbExplorerSP.executeQuery')
    .map((c) => String((c.requestBody as { sql?: unknown } | undefined)?.sql ?? ''));

/**
 * A demo dictionary bigger than the gateway row cap, like a real one: 50 fictitious TDDCAM rows
 * come first, then TSICID's 3 columns, then TGFPAR's. The cap (54 rows) ends the whole-dictionary
 * read at TGFPAR.CODPARC, so it never sees TGFPAR.NOMEPARC. Every filtered read fits.
 */
const CUT_DICTIONARY = { dictionaryPadding: 50, queryRowCap: 54 };

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

describe('MetadataService.table (one table, read on demand)', () => {
  it('finds a column the cut whole-dictionary read never saw (TGFPAR.NOMEPARC regression)', async () => {
    const { service, conn, mock } = await setup(CUT_DICTIONARY);
    const svc = service();
    // The precondition: the global catalog is cut before NOMEPARC.
    const catalog = await svc.get(conn.id);
    expect(catalog.degraded).toContain('TDDCAM:truncated');
    const global = catalog.tables.find((t) => t.name === 'TGFPAR');
    expect(global?.columns.map((c) => c.name)).toEqual(['CODPARC']);

    const before = sqls(mock).length;
    const par = await svc.table(conn.id, 'tgfpar');
    expect(par).toMatchObject({ name: 'TGFPAR', entityName: 'Parceiro' });
    expect(par?.description).toBe('Parceiros (demo)');
    expect(par?.columns.find((c) => c.name === 'CODPARC')).toMatchObject({
      type: 'integer',
      pk: true,
    });
    expect(par?.columns.find((c) => c.name === 'NOMEPARC')).toMatchObject({
      type: 'string',
      pk: false,
    });
    expect(par?.columns.some((c) => c.name.startsWith('CAMPO'))).toBe(false);
    // Every read was filtered by the table; none read the whole dictionary again.
    const reads = sqls(mock).slice(before);
    expect(reads).toHaveLength(4);
    for (const sql of reads) expect(sql).toContain("= 'TGFPAR'");
  });

  it('serves a second lookup from memory and reads again after the TTL', async () => {
    const { service, conn, mock, advance } = await setup();
    const svc = service();
    const first = await svc.table(conn.id, 'TGFPAR');
    const before = queries(mock);
    expect(await svc.table(conn.id, 'TGFPAR')).toBe(first);
    expect(queries(mock)).toBe(before);
    advance(TABLE_TTL_MS);
    expect(await svc.table(conn.id, 'TGFPAR')).toEqual(first);
    expect(queries(mock)).toBe(before + 4);
  });

  it('drops the tables of a connection on invalidate and on a refreshed get', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    await svc.table(conn.id, 'TGFPAR');
    let before = queries(mock);
    await svc.invalidate(conn.id);
    await svc.table(conn.id, 'TGFPAR');
    expect(queries(mock)).toBe(before + 4);
    await svc.get(conn.id, { refresh: true });
    before = queries(mock);
    await svc.table(conn.id, 'TGFPAR');
    expect(queries(mock)).toBe(before + 4);
  });

  it('never keeps a lookup that was still running when the connection was invalidated', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    const stale = svc.table(conn.id, 'TGFPAR');
    await svc.invalidate(conn.id);
    await stale;
    // The lookup started before the invalidation answered its caller but was not kept.
    const before = queries(mock);
    await svc.table(conn.id, 'TGFPAR');
    expect(queries(mock)).toBe(before + 4);

    // A caller arriving after an invalidation never joins a lookup started before it.
    await svc.invalidate(conn.id);
    const running = svc.table(conn.id, 'TGFPAR');
    await svc.invalidate(conn.id);
    const fresh = svc.table(conn.id, 'TGFPAR');
    expect(fresh).not.toBe(running);
    await Promise.all([running, fresh]);
  });

  it('answers undefined for a table the connection does not have, reading only TDDTAB', async () => {
    const { service, conn, mock } = await setup();
    const before = queries(mock);
    expect(await service().table(conn.id, 'TGFNAOEXISTE')).toBeUndefined();
    expect(queries(mock)).toBe(before + 1);
  });

  it('never sends a name that is not a plain identifier to the gateway', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    const names = ["TGFPAR' OR '1'='1", 'TGFPAR--', 'SANKHYA.TGFPAR', '', 'TGF PAR', '1TGFPAR'];
    for (const name of names) expect(await svc.table(conn.id, name), name).toBeUndefined();
    expect(queries(mock)).toBe(0);
  });

  it.each(['FROM TDDTAB', 'FROM TDDCAM', 'FROM TDDINS', 'ALL_CONSTRAINTS'])(
    'fails closed when the %s read fails, and caches nothing',
    async (sqlIncludes) => {
      const { service, conn, mock } = await setup();
      const svc = service();
      mock.inject({ type: 'malformed' }, { sqlIncludes });
      const err = await svc.table(conn.id, 'TGFPAR').then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: 'SANKHYA_API_ERROR', details: { table: 'TGFPAR' } });
      // The failure is not kept: the next lookup reads again and gets the whole table.
      const par = await svc.table(conn.id, 'TGFPAR');
      expect(par?.columns.map((c) => c.name)).toContain('NOMEPARC');
    },
  );

  it('fails closed when a filtered read is cut at the row cap, instead of answering fewer columns', async () => {
    const { service, conn } = await setup({ queryRowCap: 3 });
    const err = await service()
      .table(conn.id, 'TGFPAR')
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toMatchObject({
      code: 'SANKHYA_API_ERROR',
      details: { table: 'TGFPAR', read: 'TDDCAM:truncated' },
    });
  });

  it('reads the primary key filtered by the table on SQL Server too', async () => {
    const { service, conn, mock } = await setup({ dialect: 'mssql' });
    const par = await service().table(conn.id, 'TGFPAR');
    expect(par?.columns.filter((c) => c.pk).map((c) => c.name)).toEqual(['CODPARC']);
    expect(sqls(mock).at(-1)).toContain("UPPER(tc.TABLE_NAME) = 'TGFPAR'");
  });

  it('never mixes the tables of two connections', async () => {
    const a = await setup();
    const b = await setup();
    // Connection B's dictionary has a column A's does not.
    await b.mock.db.query(
      "INSERT INTO TDDCAM (NUCAMPO, NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO) VALUES (9001, 'TGFPAR', 'SOEMB', 'Só em B', 'S')",
    );
    const owners = new Map([
      [a.conn.id, a.conns],
      [b.conn.id, b.conns],
    ]);
    const svc = new MetadataService(a.database.db, {
      getRuntime: (id) => owners.get(id)!.getRuntime(id),
    });
    const names = async (id: string) =>
      (await svc.table(id, 'TGFPAR'))?.columns.map((c) => c.name) ?? [];
    expect(await names(b.conn.id)).toContain('SOEMB');
    expect(await names(a.conn.id)).not.toContain('SOEMB');
    // Both are cached now, and each still answers its own; invalidating A keeps B's.
    expect(await names(b.conn.id)).toContain('SOEMB');
    expect(await names(a.conn.id)).not.toContain('SOEMB');
    await svc.invalidate(a.conn.id);
    const before = queries(b.mock);
    expect(await names(b.conn.id)).toContain('SOEMB');
    expect(queries(b.mock)).toBe(before);
  });
});
