import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_TABLES, createMockSankhya } from '@dbx/sankhya-client/mock';
import type { MockSankhya } from '@dbx/sankhya-client/mock';
import { isAppError } from '@dbx/shared';
import { loadConfig } from '../config';
import { materialize } from './materialize';
import type { Catalog } from './metadata';
import type { PolicyDecision } from './read-executor';
import { MOCK_BASE_URL, createSankhyaRuntime } from './sankhya-runtime';
import type { SankhyaRuntime } from './sankhya-runtime';
import { ScratchManager, type ScratchManagerOptions } from './scratch';

// Fictitious credentials, used only by these tests.
const SECRETS = {
  clientId: 'client-id-fixture-0123456789',
  clientSecret: 'client-secret-fixture-value-zz',
  xToken: 'x-token-fixture-value-qq',
};

const CATALOG: Catalog = {
  tables: MOCK_TABLES.map((t) => ({
    name: t.table,
    columns: t.columns.map((c) => ({ name: c.name, type: 'string', pk: false })),
    foreignKeys: [],
  })),
  fetchedAt: '2026-01-01T00:00:00.000Z',
  source: 'dictionary',
};

const allow = (): PolicyDecision => ({ effect: 'ALLOW' });

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(
  opts: { queryRowCap?: number; scratch?: Partial<ScratchManagerOptions> } = {},
): Promise<{ runtime: SankhyaRuntime; mock: MockSankhya; manager: ScratchManager }> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'pglite:memory',
    LOG_LEVEL: 'silent',
    SANKHYA_ALLOWED_HOSTS: 'gateway.example.com',
  });
  const mock = await createMockSankhya({
    seed: 7,
    ...SECRETS,
    ...(opts.queryRowCap ? { queryRowCap: opts.queryRowCap } : {}),
  });
  cleanup.push(() => mock.close());
  const runtime = createSankhyaRuntime(
    {
      id: 'c1',
      name: 'Demo',
      environment: 'SANDBOX',
      mode: 'mock',
      baseUrl: MOCK_BASE_URL,
      dialect: 'oracle',
      ...SECRETS,
    },
    config,
    { mockGateway: mock },
  );
  cleanup.push(() => Promise.resolve(runtime.close()));
  const manager = new ScratchManager({
    maxWorkspaces: 2,
    maxRows: 10_000,
    maxTables: 5,
    ttlMinutes: 60,
    statementTimeoutMs: 10_000,
    sweepIntervalMs: 0,
    ...opts.scratch,
  });
  cleanup.push(() => manager.closeAll());
  return { runtime, mock, manager };
}

const queries = (mock: MockSankhya) =>
  mock.calls.filter((c) => c.serviceName === 'DbExplorerSP.executeQuery').length;

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!isAppError(e)) throw new Error(`expected an AppError, got ${String(e)}`);
  return e.code;
}

describe('materialize', () => {
  it('materializes TGFPAR into tmp_par with lowercase columns', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const out = await materialize({
      runtime,
      workspace,
      sql: 'SELECT CODPARC, NOMEPARC, CODCID FROM TGFPAR',
      into: 'tmp_par',
      maxRows: 1_000,
      decide: allow,
      catalog: CATALOG,
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ table: 'tmp_par', rows: 60, truncated: false });
    expect(await workspace.tables()).toEqual([{ name: 'tmp_par', rows: 60 }]);
    const res = await workspace.exec('SELECT codparc, nomeparc FROM tmp_par ORDER BY codparc');
    expect(res.columns).toEqual(['codparc', 'nomeparc']);
    expect(res.rows[0]![0]).toBe('1');
    expect(typeof res.rows[0]![1]).toBe('string');
  }, 60_000);

  it('reports truncation above maxRows and keeps exactly maxRows rows', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const out = await materialize({
      runtime,
      workspace,
      sql: 'SELECT CODPARC FROM TGFPAR',
      into: 'tmp_par',
      maxRows: 10,
      decide: allow,
      catalog: CATALOG,
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ table: 'tmp_par', rows: 10, truncated: true });
    expect(await workspace.tables()).toEqual([{ name: 'tmp_par', rows: 10 }]);
  }, 60_000);

  it('reports truncation when the gateway cuts the result', async () => {
    const { runtime, manager } = await setup({ queryRowCap: 5 });
    const workspace = await manager.workspace('u1');
    const out = await materialize({
      runtime,
      workspace,
      sql: 'SELECT CODPARC FROM TGFPAR',
      into: 'tmp_par',
      maxRows: 1_000,
      decide: allow,
      catalog: CATALOG,
      signal: new AbortController().signal,
    });
    expect(out).toEqual({ table: 'tmp_par', rows: 5, truncated: true });
    expect(await workspace.tables()).toEqual([{ name: 'tmp_par', rows: 5 }]);
  }, 60_000);

  it('a hybrid join between a materialized table and a scratch table works', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    await materialize({
      runtime,
      workspace,
      sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR',
      into: 'tmp_par',
      maxRows: 1_000,
      decide: allow,
      catalog: CATALOG,
      signal: new AbortController().signal,
    });
    await workspace.exec('CREATE TABLE tmp_x (codparc numeric, nota text)');
    await workspace.exec("INSERT INTO tmp_x VALUES (1, 'a'), (2, 'b'), (999999, 'none')");
    const res = await workspace.exec(
      'SELECT p.codparc, x.nota FROM tmp_par p JOIN tmp_x x ON p.codparc = x.codparc ORDER BY p.codparc',
    );
    expect(res.rows).toEqual([
      ['1', 'a'],
      ['2', 'b'],
    ]);
  }, 60_000);

  it('refuses a target that is not a tmp_* name before calling the gateway', async () => {
    const { runtime, mock, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const before = queries(mock);
    for (const into of ['par', 'TMP_PAR', 'tmp_', 'tmp_a;drop', 'public.tmp_a', '']) {
      expect(
        await codeOf(
          materialize({
            runtime,
            workspace,
            sql: 'SELECT CODPARC FROM TGFPAR',
            into,
            maxRows: 10,
            decide: allow,
            catalog: CATALOG,
            signal: new AbortController().signal,
          }),
        ),
      ).toBe('VALIDATION_ERROR');
    }
    expect(queries(mock)).toBe(before);
  }, 60_000);

  it('a policy denial creates nothing', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    expect(
      await codeOf(
        materialize({
          runtime,
          workspace,
          sql: 'SELECT CODPARC FROM TGFPAR',
          into: 'tmp_par',
          maxRows: 10,
          decide: () => ({ effect: 'DENY', reason: 'no' }),
          catalog: CATALOG,
          signal: new AbortController().signal,
        }),
      ),
    ).toBe('FORBIDDEN');
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);

  it('refuses anything but a read', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const code = await codeOf(
      materialize({
        runtime,
        workspace,
        sql: 'DELETE FROM TGFPAR',
        into: 'tmp_par',
        maxRows: 10,
        decide: allow,
        catalog: CATALOG,
        signal: new AbortController().signal,
      }),
    );
    expect(['SQL_FORBIDDEN', 'SQL_UNSUPPORTED', 'SQL_PARSE_ERROR']).toContain(code);
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);

  it('a materialization over the workspace row quota is rolled back', async () => {
    const { runtime, manager } = await setup({ scratch: { maxRows: 100 } });
    const workspace = await manager.workspace('u1');
    await workspace.exec('CREATE TABLE tmp_a (g int)');
    await workspace.exec('INSERT INTO tmp_a SELECT g FROM generate_series(1, 50) g');
    expect(
      await codeOf(
        materialize({
          runtime,
          workspace,
          sql: 'SELECT CODPARC FROM TGFPAR',
          into: 'tmp_par',
          maxRows: 1_000,
          decide: allow,
          catalog: CATALOG,
          signal: new AbortController().signal,
        }),
      ),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect(await workspace.tables()).toEqual([{ name: 'tmp_a', rows: 50 }]);
  }, 60_000);

  it('an aborted signal stops the materialization', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const controller = new AbortController();
    controller.abort();
    expect(
      await codeOf(
        materialize({
          runtime,
          workspace,
          sql: 'SELECT CODPARC FROM TGFPAR',
          into: 'tmp_par',
          maxRows: 10,
          decide: allow,
          catalog: CATALOG,
          signal: controller.signal,
        }),
      ),
    ).toBe('QUERY_CANCELLED');
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);

  const READ = { sql: 'SELECT CODPARC FROM TGFPAR', into: 'tmp_par', maxRows: 10 };

  it('an abort while deciding stops before the gateway and creates nothing', async () => {
    const { runtime, mock, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const controller = new AbortController();
    const before = queries(mock);
    const code = await codeOf(
      materialize({
        ...READ,
        runtime,
        workspace,
        decide: async () => {
          controller.abort();
          return { effect: 'ALLOW' };
        },
        catalog: CATALOG,
        signal: controller.signal,
      }),
    );
    expect(code).toBe('QUERY_CANCELLED');
    expect(queries(mock)).toBe(before);
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);

  it('an abort after the read creates nothing', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const controller = new AbortController();
    const read = runtime.client.executeQuery.bind(runtime.client);
    runtime.client.executeQuery = async (sql, signal) => {
      const result = await read(sql, signal);
      controller.abort();
      return result;
    };
    const code = await codeOf(
      materialize({
        ...READ,
        runtime,
        workspace,
        decide: allow,
        catalog: CATALOG,
        signal: controller.signal,
      }),
    );
    expect(code).toBe('QUERY_CANCELLED');
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);

  it('an abort during the import rolls the table back', async () => {
    const { runtime, manager } = await setup();
    const workspace = await manager.workspace('u1');
    const controller = new AbortController();
    const importRows = workspace.importRows.bind(workspace);
    workspace.importRows = (...args) => {
      const pending = importRows(...args);
      controller.abort();
      return pending;
    };
    const code = await codeOf(
      materialize({
        ...READ,
        runtime,
        workspace,
        decide: allow,
        catalog: CATALOG,
        signal: controller.signal,
      }),
    );
    expect(code).toBe('QUERY_CANCELLED');
    expect(await workspace.tables()).toEqual([]);
  }, 60_000);
});
