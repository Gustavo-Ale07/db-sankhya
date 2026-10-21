import { describe, expect, it, vi } from 'vitest';
import type { QueryResult } from '@dbx/sankhya-client';
import { isAppError } from '@dbx/shared';
import type { AppError } from '@dbx/shared';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type * as SqlEngine from '@dbx/sql-engine';
import type { Catalog } from './metadata';
import { executeRead } from './read-executor';
import type { PolicyDecision } from './read-executor';
import type { Dialect, SankhyaRuntime } from './sankhya-runtime';

/** Lets a test make the gate refuse the wrapped statement only (the M1 fail-closed path). */
const gateHook = vi.hoisted(() => ({ refuseWrapped: false }));
vi.mock('@dbx/sql-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof SqlEngine>();
  return {
    ...actual,
    tokenGate: (sql: string) =>
      gateHook.refuseWrapped && sql.includes('ROWNUM')
        ? { ok: false as const, code: 'SQL_FORBIDDEN' as const, reason: 'test' }
        : actual.tokenGate(sql),
  };
});

const CATALOG: Catalog = {
  tables: ['TGFPAR', 'TSICID'].map((name) => ({ name, columns: [], foreignKeys: [] })),
  fetchedAt: '2026-01-01T00:00:00.000Z',
  source: 'dictionary',
};

const allow = (): PolicyDecision => ({ effect: 'ALLOW' });

function fakeRuntime(dialect: Dialect, result: Partial<QueryResult> = {}) {
  const executeQuery = vi.fn(async (_sql: string, _signal?: AbortSignal): Promise<QueryResult> => ({
    columns: ['CODPARC'],
    rows: [[1], [2]],
    truncated: false,
    ...result,
  }));
  const runtime = {
    client: { executeQuery },
    connectionId: 'c1',
    environment: 'SANDBOX',
    dialect,
    mode: 'mock',
    close: () => undefined,
  } as unknown as SankhyaRuntime;
  return { runtime, executeQuery };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    if (isAppError(err)) return err;
    throw err;
  }
  throw new Error('expected an error');
}

const base = (runtime: SankhyaRuntime, sql: string, extra: Record<string, unknown> = {}) => ({
  runtime,
  catalog: CATALOG,
  sql,
  maxRows: 10,
  signal: new AbortController().signal,
  decide: allow,
  ...extra,
});

describe('executeRead', () => {
  it('wraps an Oracle read with ROWNUM <= maxRows + 1 and returns the rows', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR ORDER BY CODPARC;'));
    expect(executeQuery).toHaveBeenCalledTimes(1);
    expect(executeQuery.mock.calls[0]![0]).toBe(
      'SELECT * FROM (SELECT CODPARC FROM TGFPAR ORDER BY CODPARC) WHERE ROWNUM <= 11',
    );
    expect(out).toMatchObject({ columns: ['CODPARC'], rows: [[1], [2]], truncated: false });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('wraps an MSSQL read without ORDER BY in TOP (maxRows + 1)', async () => {
    const { runtime, executeQuery } = fakeRuntime('mssql');
    await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR'));
    expect(executeQuery.mock.calls[0]![0]).toBe(
      'SELECT TOP (11) * FROM (SELECT CODPARC FROM TGFPAR) AS dbx_q',
    );
  });

  it('sends an MSSQL read with an outer ORDER BY unwrapped and truncates client-side', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => [i + 1]);
    const { runtime, executeQuery } = fakeRuntime('mssql', { rows });
    const sql = 'SELECT CODPARC FROM TGFPAR ORDER BY CODPARC';
    const out = await executeRead(base(runtime, sql));
    expect(executeQuery.mock.calls[0]![0]).toBe(sql);
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it('sends an MSSQL read with a CTE unwrapped (T-SQL has no WITH in a derived table)', async () => {
    const { runtime, executeQuery } = fakeRuntime('mssql');
    const sql = 'WITH x AS (SELECT CODPARC FROM TGFPAR) SELECT CODPARC FROM x';
    await executeRead(base(runtime, sql));
    expect(executeQuery.mock.calls[0]![0]).toBe(sql);
  });

  it('returns maxRows rows and truncated: true when the cap is exceeded', async () => {
    const rows = Array.from({ length: 11 }, (_, i) => [i + 1]);
    const { runtime } = fakeRuntime('oracle', { rows });
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR'));
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it('reports truncated when the gateway cut the result at its own cap', async () => {
    const { runtime } = fakeRuntime('oracle', { truncated: true });
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR'));
    expect(out.truncated).toBe(true);
  });

  it('refuses at the gate with SQL_FORBIDDEN before anything else', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const decide = vi.fn(allow);
    for (const sql of [
      'SELECT CODPARC FROM TGFPAR; DELETE FROM TGFPAR',
      'SELECT CODPARC FROM TGFPAR -- x',
      'SELECT 0x41 FROM TGFPAR',
    ]) {
      const e = await errorOf(executeRead(base(runtime, sql, { decide })));
      expect(e.code, sql).toBe('SQL_FORBIDDEN');
      expect(e.status).toBe(400);
    }
    expect(decide).not.toHaveBeenCalled();
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('refuses statements the analyzer does not allow (fail closed)', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    expect((await errorOf(executeRead(base(runtime, 'SELEC * FRM TGFPAR')))).code).toMatch(
      /SQL_PARSE_ERROR|SQL_UNSUPPORTED/,
    );
    expect((await errorOf(executeRead(base(runtime, 'SELECT MY_FN(1) FROM TGFPAR')))).code).toBe(
      'SQL_UNSUPPORTED',
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('refuses a table missing from the catalog with RESOURCE_NOT_FOUND', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const e = await errorOf(
      executeRead(base(runtime, 'SELECT P.CODPARC FROM tgfpar P JOIN TGFXYZ X ON 1 = 1')),
    );
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toContain('TGFXYZ');
    expect(e.message).not.toMatch(/incomplete/i);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('still refuses an unknown table when the table list is degraded, saying so', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const catalog: Catalog = { ...CATALOG, degraded: ['TDDTAB:truncated'] };
    const e = await errorOf(executeRead(base(runtime, 'SELECT X FROM TGFXYZ', { catalog })));
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toMatch(/incomplete/i);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('looks a table up on its own when the table list is degraded, before refusing it', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const catalog: Catalog = { ...CATALOG, degraded: ['TDDTAB:truncated'] };
    const tgfxyz = {
      name: 'TGFXYZ',
      columns: [{ name: 'X', type: 'I', pk: false }],
      foreignKeys: [],
    };
    const findTable = vi.fn(async (name: string) => (name === 'TGFXYZ' ? tgfxyz : undefined));
    const decide = vi.fn((_a: ReadAnalysis, _c: Catalog): PolicyDecision => ({ effect: 'ALLOW' }));
    await executeRead(base(runtime, 'SELECT X FROM tgfxyz', { catalog, findTable, decide }));
    expect(findTable).toHaveBeenCalledWith('TGFXYZ');
    // The policy sees the table that was found, with its columns.
    expect(decide.mock.calls[0]![1].tables).toContainEqual(tgfxyz);
    expect(executeQuery).toHaveBeenCalledTimes(1);

    // Not found on its own either: refused as before, saying the catalog is incomplete.
    const e = await errorOf(
      executeRead(base(runtime, 'SELECT Y FROM TGFNOPE', { catalog, findTable, decide })),
    );
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(e.message).toMatch(/incomplete/i);
    expect(executeQuery).toHaveBeenCalledTimes(1);
  });

  it('never looks a missing table up when the table list is whole', async () => {
    const { runtime } = fakeRuntime('oracle');
    const findTable = vi.fn(async () => undefined);
    const e = await errorOf(executeRead(base(runtime, 'SELECT X FROM TGFXYZ', { findTable })));
    expect(e.code).toBe('RESOURCE_NOT_FOUND');
    expect(findTable).not.toHaveBeenCalled();
  });

  it('asks decide with the analysis and maps DENY to FORBIDDEN', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const decide = vi.fn((_a: ReadAnalysis): PolicyDecision => ({
      effect: 'DENY',
      reason: 'no read',
    }));
    const e = await errorOf(executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { decide })));
    expect(e.code).toBe('FORBIDDEN');
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0].tables).toEqual([{ name: 'TGFPAR' }]);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('awaits an async decision and caps the rows at its maxRows', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle', { rows: [[1], [2], [3], [4]] });
    const decide = async (): Promise<PolicyDecision> => ({ effect: 'ALLOW', maxRows: 3 });
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { decide }));
    expect(executeQuery.mock.calls[0]![0]).toContain('ROWNUM <= 4');
    expect(out).toMatchObject({ rows: [[1], [2], [3]], truncated: true, maxRows: 3 });

    // A policy cap never raises the caller's ceiling.
    const high = async (): Promise<PolicyDecision> => ({ effect: 'ALLOW', maxRows: 500 });
    const capped = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { decide: high }));
    expect(executeQuery.mock.calls[1]![0]).toContain('ROWNUM <= 11');
    expect(capped.maxRows).toBe(10);
  });

  it('fails closed on an async DENY, a rejected decision or a zero row cap', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const sql = 'SELECT CODPARC FROM TGFPAR';
    const deny = async (): Promise<PolicyDecision> => ({ effect: 'DENY' });
    expect((await errorOf(executeRead(base(runtime, sql, { decide: deny })))).code).toBe(
      'FORBIDDEN',
    );
    const zero = async (): Promise<PolicyDecision> => ({ effect: 'ALLOW', maxRows: 0 });
    expect((await errorOf(executeRead(base(runtime, sql, { decide: zero })))).code).toBe(
      'FORBIDDEN',
    );
    const broken = () => Promise.reject(new Error('policy store down'));
    await expect(executeRead(base(runtime, sql, { decide: broken }))).rejects.toThrow(
      'policy store down',
    );
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('does not reach the gateway when aborted while deciding', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const controller = new AbortController();
    const decide = async (): Promise<PolicyDecision> => {
      controller.abort();
      return { effect: 'ALLOW' };
    };
    const e = await errorOf(
      executeRead(
        base(runtime, 'SELECT CODPARC FROM TGFPAR', { decide, signal: controller.signal }),
      ),
    );
    expect(e.code).toBe('QUERY_CANCELLED');
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('maps an abort to QUERY_CANCELLED', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    const controller = new AbortController();
    controller.abort();
    const e = await errorOf(
      executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { signal: controller.signal })),
    );
    expect(e.code).toBe('QUERY_CANCELLED');
    expect(executeQuery).not.toHaveBeenCalled();

    const late = new AbortController();
    executeQuery.mockImplementationOnce(async () => {
      late.abort();
      throw new Error('socket closed');
    });
    const e2 = await errorOf(
      executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { signal: late.signal })),
    );
    expect(e2.code).toBe('QUERY_CANCELLED');
  });

  describe('shapes the wrapper would break are sent unwrapped and capped client-side', () => {
    const JOIN = 'FROM TGFPAR P JOIN TSICID C ON C.CODCID = P.CODCID';
    it.each([
      ['oracle', 'SELECT COUNT(*) FROM TGFPAR'],
      ['mssql', 'SELECT COUNT(*) FROM TGFPAR'],
      ['oracle', `SELECT P.*, C.* ${JOIN}`],
      ['mssql', `SELECT P.*, C.* ${JOIN}`],
      ['oracle', `SELECT P.CODCID, C.CODCID ${JOIN}`],
      ['mssql', `SELECT P.CODCID, C.CODCID ${JOIN}`],
    ] as const)('%s: %s', async (dialect, sql) => {
      const rows = Array.from({ length: 12 }, (_, i) => [i + 1]);
      const { runtime, executeQuery } = fakeRuntime(dialect, { rows });
      const out = await executeRead(base(runtime, `${sql};`));
      expect(executeQuery.mock.calls[0]![0]).toBe(sql);
      expect(out.rows).toHaveLength(10);
      expect(out.truncated).toBe(true);
    });

    it.each([
      ['oracle', 'SELECT * FROM (SELECT COUNT(*) AS TOTAL FROM TGFPAR) WHERE ROWNUM <= 11'],
      ['mssql', 'SELECT TOP (11) * FROM (SELECT COUNT(*) AS TOTAL FROM TGFPAR) AS dbx_q'],
    ] as const)('%s: still wraps an aliased aggregate', async (dialect, expected) => {
      const { runtime, executeQuery } = fakeRuntime(dialect);
      await executeRead(base(runtime, 'SELECT COUNT(*) AS TOTAL FROM TGFPAR'));
      expect(executeQuery.mock.calls[0]![0]).toBe(expected);
    });
  });

  it('refuses with INTERNAL_ERROR when the wrapped statement fails the gate (fail closed)', async () => {
    const { runtime, executeQuery } = fakeRuntime('oracle');
    gateHook.refuseWrapped = true;
    try {
      const e = await errorOf(executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR')));
      expect(e.code).toBe('INTERNAL_ERROR');
    } finally {
      gateHook.refuseWrapped = false;
    }
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('exactly maxRows rows is not truncated', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i + 1]);
    const { runtime } = fakeRuntime('oracle', { rows });
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR'));
    expect(out.rows).toHaveLength(10);
    expect(out).toMatchObject({ truncated: false, truncatedBy: null });
  });

  it('slices an unwrapped MSSQL CTE read that returns more than maxRows', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => [i + 1]);
    const { runtime } = fakeRuntime('mssql', { rows });
    const out = await executeRead(
      base(runtime, 'WITH x AS (SELECT CODPARC FROM TGFPAR) SELECT CODPARC FROM x'),
    );
    expect(out.rows).toEqual(rows.slice(0, 10));
    expect(out).toMatchObject({ truncated: true, truncatedBy: 'maxRows' });
  });

  it('tells a gateway cut below maxRows apart from the row cap', async () => {
    const { runtime } = fakeRuntime('oracle', { truncated: true });
    const out = await executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR'));
    expect(out).toMatchObject({ truncated: true, truncatedBy: 'gateway' });
  });

  it('rejects a non-positive or non-integer maxRows', async () => {
    const { runtime } = fakeRuntime('oracle');
    for (const maxRows of [0, -1, 1.5, Number.NaN]) {
      await expect(
        executeRead(base(runtime, 'SELECT CODPARC FROM TGFPAR', { maxRows })),
      ).rejects.toThrow();
    }
  });
});
