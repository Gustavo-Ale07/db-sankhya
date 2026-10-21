import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { connections, createDatabase, metadataCache } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { createMockSankhya } from '@dbx/sankhya-client/mock';
import { isAppError } from '@dbx/shared';
import { loadConfig } from '../config';
import { ConnectionsService } from './connections';
import {
  DEGRADED_TTL_MS,
  MAX_FIELD_PAGES,
  METADATA_TTL_MS,
  MetadataService,
  TABLE_TTL_MS,
} from './metadata';

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
  opts: {
    dialect?: 'oracle' | 'mssql';
    queryRowCap?: number;
    dictionaryPadding?: number;
    unpagedDictionary?: boolean;
    silentCut?: boolean;
  } = {},
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
    ...(opts.unpagedDictionary ? { unpagedDictionary: true } : {}),
    ...(opts.silentCut ? { silentCut: true } : {}),
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
const CUT_DICTIONARY = { dictionaryPadding: 50, queryRowCap: 54, unpagedDictionary: true };

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
    // TDDTAB, TDDCAM, TDDINS and PK once each, every one with its count.
    expect(queries(mock)).toBe(8);
  });

  it('returns tables without columns when the TDDCAM query fails', async () => {
    const { service, conn, mock } = await setup();
    // Both the paged read and the single read it falls back to.
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
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

  it('keeps a degraded catalog in memory for DEGRADED_TTL_MS only and never persists it', async () => {
    const { service, conn, mock, database, advance } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const svc = service();
    const degraded = await svc.get(conn.id);
    expect(degraded.degraded).toEqual(['TDDCAM:failed']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);

    advance(DEGRADED_TTL_MS - 1);
    const before = mock.calls.length;
    expect(await svc.get(conn.id)).toBe(degraded);
    expect(mock.calls.length).toBe(before);

    // After the short expiry the catalog is read again and, now complete, persisted.
    advance(1);
    await svc.get(conn.id);
    const healed = await vi.waitFor(async () => {
      const c = await svc.get(conn.id);
      expect(c.degraded).toBeUndefined();
      return c;
    });
    expect(healed.tables.find((t) => t.name === 'TGFPAR')?.columns.length).toBeGreaterThan(0);
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);
  });

  it('marks cut reads as degraded and keeps what they read; the table list is paged whole', async () => {
    const { service, conn, mock, database } = await setup({
      queryRowCap: 3,
      unpagedDictionary: true,
    });
    const catalog = await service().get(conn.id);
    const { rows } = await mock.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM TDDTAB');
    expect(catalog.tables).toHaveLength(rows[0]!.n);
    expect(catalog.degraded).toEqual(['TDDCAM:truncated', 'TDDINS:truncated', 'PK:truncated']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });

  it('never keeps a discovery that was still running when the connection was invalidated', async () => {
    const { service, conn, mock, database } = await setup();
    const svc = service();
    const stale = svc.get(conn.id);
    await svc.invalidate(conn.id);
    // A caller arriving after the invalidation never joins the discovery started before it.
    const fresh = svc.get(conn.id);
    expect(fresh).not.toBe(stale);
    await Promise.all([stale, fresh]);

    // Only the discovery started after the invalidation was kept.
    await svc.invalidate(conn.id);
    const running = svc.get(conn.id);
    await svc.invalidate(conn.id);
    await running;
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
    const before = queries(mock);
    await svc.get(conn.id);
    expect(queries(mock)).toBeGreaterThan(before);
  });

  it('serves an expired degraded catalog while one discovery reads it again behind it', async () => {
    const { service, conn, mock, database, advance } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const svc = service();
    const degraded = await svc.get(conn.id);
    expect(degraded.degraded).toEqual(['TDDCAM:failed']);

    advance(DEGRADED_TTL_MS);
    // Answered at once with what is known, while a single discovery reads it again.
    const [a, b] = await Promise.all([svc.get(conn.id), svc.get(conn.id)]);
    expect(a).toBe(degraded);
    expect(b).toBe(degraded);
    await vi.waitFor(async () => expect((await svc.get(conn.id)).degraded).toBeUndefined());
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);
  });

  it('reads a degraded catalog older than the full TTL again before answering', async () => {
    const { service, conn, mock, advance } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const svc = service();
    expect((await svc.get(conn.id)).degraded).toEqual(['TDDCAM:failed']);
    advance(METADATA_TTL_MS);
    expect((await svc.get(conn.id)).degraded).toBeUndefined();
  });

  it('keeps a degraded catalog for the configured time, 10 minutes by default', async () => {
    expect(DEGRADED_TTL_MS).toBe(10 * 60 * 1000);
    const { conn, conns, database, mock } = await setup();
    let clock = Date.UTC(2026, 0, 1);
    const svc = new MetadataService(database.db, {
      getRuntime: (id) => conns.getRuntime(id),
      now: () => clock,
      degradedTtlMs: 1000,
    });
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'FROM TDDCAM' });
    const degraded = await svc.get(conn.id);
    clock += 999;
    const before = queries(mock);
    expect(await svc.get(conn.id)).toBe(degraded);
    expect(queries(mock)).toBe(before);
    clock += 1;
    await svc.get(conn.id);
    await vi.waitFor(() => expect(queries(mock)).toBeGreaterThan(before));
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

describe('MetadataService, a dictionary bigger than the gateway row cap', () => {
  /** The same dictionary as CUT_DICTIONARY, on a gateway that can serve it in pages. */
  const PAGED = { dictionaryPadding: 50, queryRowCap: 54 };
  const pages = (mock: Parameters<typeof sqls>[0]) =>
    sqls(mock).filter((q) => q.includes('ORDER BY NUCAMPO'));

  it('reads TDDCAM in pages into a whole catalog, persisted and kept for the full TTL', async () => {
    const { service, conn, mock, database, advance } = await setup(PAGED);
    const svc = service();
    const catalog = await svc.get(conn.id);

    expect(catalog.degraded).toBeUndefined();
    const par = catalog.tables.find((t) => t.name === 'TGFPAR');
    expect(par?.columns.map((c) => c.name)).toContain('NOMEPARC');
    expect(par?.columns.find((c) => c.name === 'CODPARC')?.pk).toBe(true);
    // Each page starts after the last key of the one before, and the total is checked.
    const read = pages(mock);
    expect(read.length).toBeGreaterThan(1);
    expect(read[0]).not.toContain('NUCAMPO >');
    expect(read.slice(1).every((q) => /WHERE NUCAMPO > \d+ ORDER BY NUCAMPO$/.test(q))).toBe(true);
    expect(sqls(mock).filter((q) => q.includes('COUNT(*) AS TOTAL FROM TDDCAM'))).toHaveLength(1);
    // No column is read twice or lost: the catalog matches the dictionary row for row.
    const total = catalog.tables.reduce((n, t) => n + t.columns.length, 0);
    const { rows } = await mock.db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM TDDCAM WHERE NOMETAB IN (SELECT NOMETAB FROM TDDTAB)',
    );
    expect(total).toBe(rows[0]!.n);
    expect(await database.db.select().from(metadataCache)).toHaveLength(1);

    // Whole, so it is not read again after the minute a cut catalog is kept.
    advance(DEGRADED_TTL_MS + 1);
    const before = sqls(mock).length;
    expect(await svc.get(conn.id)).toBe(catalog);
    expect(sqls(mock).length).toBe(before);
  });

  it('reports the read as cut when the pages do not add up to the dictionary count', async () => {
    const { service, conn, mock, database } = await setup(PAGED);
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'COUNT(*) AS TOTAL FROM TDDCAM' });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toEqual(['TDDCAM:truncated']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });

  it('reports a page that fails after the first as a failed read, never as whole', async () => {
    const { service, conn, mock, database } = await setup(PAGED);
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'ORDER BY NUCAMPO', after: 1 });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toEqual(['TDDCAM:failed']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });

  it('falls back to the single read, reported as cut, when the gateway cannot page', async () => {
    const { service, conn, mock } = await setup(CUT_DICTIONARY);
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toEqual(['TDDCAM:truncated']);
    expect(sqls(mock).filter((q) => q.includes('NUCAMPO'))).toHaveLength(1);
    expect(sqls(mock)).toContain('SELECT NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM');
  });

  it(`stops after ${MAX_FIELD_PAGES} pages and reports the read as cut`, async () => {
    const { service, conn, mock } = await setup({ dictionaryPadding: 400, queryRowCap: 3 });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toContain('TDDCAM:truncated');
    expect(pages(mock)).toHaveLength(MAX_FIELD_PAGES);
  });

  it('stops after the configured number of pages', async () => {
    const { conns, conn, mock, database } = await setup({ dictionaryPadding: 400, queryRowCap: 3 });
    const svc = new MetadataService(database.db, {
      getRuntime: (id) => conns.getRuntime(id),
      maxPages: 5,
    });
    expect((await svc.get(conn.id)).degraded).toContain('TDDCAM:truncated');
    expect(pages(mock)).toHaveLength(5);
  });
});

describe('MetadataService, a gateway that cuts at its row cap without saying so', () => {
  const count = async (
    mock: { db: { query: <T>(sql: string) => Promise<{ rows: T[] }> } },
    sql: string,
  ) => (await mock.db.query<{ n: number }>(sql)).rows[0]!.n;

  it('pages TDDTAB and TDDCAM on until they add up to their counts; TDDINS and PK cut by count', async () => {
    const { service, conn, mock, database } = await setup({ queryRowCap: 3, silentCut: true });
    const catalog = await service().get(conn.id);

    // Never flagged as cut, yet each read is checked against its own count.
    expect(catalog.tables).toHaveLength(await count(mock, 'SELECT COUNT(*)::int AS n FROM TDDTAB'));
    const total = catalog.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(total).toBe(
      await count(
        mock,
        'SELECT COUNT(*)::int AS n FROM TDDCAM WHERE NOMETAB IN (SELECT NOMETAB FROM TDDTAB)',
      ),
    );
    expect(catalog.tables.find((t) => t.name === 'TGFPAR')?.columns.map((c) => c.name)).toContain(
      'NOMEPARC',
    );
    expect(
      sqls(mock).some((q) => /FROM TDDTAB WHERE NOMETAB > '[A-Z0-9_]+' ORDER BY NOMETAB$/.test(q)),
    ).toBe(true);
    expect(catalog.degraded).toEqual(['TDDINS:truncated', 'PK:truncated']);
    expect(await database.db.select().from(metadataCache)).toHaveLength(0);
  });

  it('reports a single read that does not add up to its count as cut', async () => {
    const { service, conn } = await setup({ ...CUT_DICTIONARY, silentCut: true });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toEqual(['TDDCAM:truncated']);
  });

  it('reports a read whose count cannot be read as cut, never as whole', async () => {
    const { service, conn, mock } = await setup();
    mock.inject({ type: 'malformed' }, { sqlIncludes: 'COUNT(*) AS TOTAL FROM TDDINS' });
    const catalog = await service().get(conn.id);
    expect(catalog.degraded).toEqual(['TDDINS:truncated']);
  });

  it('fails closed on one table whose columns do not add up to its count', async () => {
    const { service, conn, mock } = await setup({ queryRowCap: 3, silentCut: true });
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
    expect(sqls(mock)).toContain("SELECT COUNT(*) AS TOTAL FROM TDDCAM WHERE NOMETAB = 'TGFPAR'");
  });
});

describe('MetadataService instances (TDDINS)', () => {
  it('lists every instance of a table in name order, the first as entityName, in both reads', async () => {
    const { service, conn, mock } = await setup();
    // Inserted ahead of the real ones: the order of the rows must not choose the instance.
    await mock.db.query(
      "INSERT INTO tddins (nomeinstancia, nometab, descrinstancia) VALUES ('AEstoque', 'TGFEST', 'x')",
    );
    const svc = service();
    const est = (await svc.get(conn.id)).tables.find((t) => t.name === 'TGFEST');
    expect(est).toMatchObject({
      entityName: 'AEstoque',
      entityNames: ['AEstoque', 'Estoque', 'EstoqueLocal'],
    });
    expect(await svc.table(conn.id, 'TGFEST')).toMatchObject({
      entityName: 'AEstoque',
      entityNames: ['AEstoque', 'Estoque', 'EstoqueLocal'],
    });
    expect((await svc.table(conn.id, 'TGFPAR'))?.entityNames).toEqual(['Parceiro']);
    expect(sqls(mock).filter((q) => q.includes('NOMEINSTANCIA FROM TDDINS'))).toEqual([
      'SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS ORDER BY NOMETAB, NOMEINSTANCIA',
      "SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS WHERE NOMETAB = 'TGFEST' ORDER BY NOMEINSTANCIA",
      "SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS WHERE NOMETAB = 'TGFPAR' ORDER BY NOMEINSTANCIA",
    ]);
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
    expect(reads).toHaveLength(5);
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
    expect(queries(mock)).toBe(before + 5);
  });

  it('drops the tables of a connection on invalidate and on a refreshed get', async () => {
    const { service, conn, mock } = await setup();
    const svc = service();
    await svc.table(conn.id, 'TGFPAR');
    let before = queries(mock);
    await svc.invalidate(conn.id);
    await svc.table(conn.id, 'TGFPAR');
    expect(queries(mock)).toBe(before + 5);
    await svc.get(conn.id, { refresh: true });
    before = queries(mock);
    await svc.table(conn.id, 'TGFPAR');
    expect(queries(mock)).toBe(before + 5);
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
    expect(queries(mock)).toBe(before + 5);

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
