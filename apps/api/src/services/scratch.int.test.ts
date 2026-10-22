import { afterEach, describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@dbx/shared';
import { ScratchManager, type ScratchManagerOptions } from './scratch';
import { analyzeScratchSql } from './scratch-guard';

const managers: ScratchManager[] = [];

function manager(overrides: Partial<ScratchManagerOptions> = {}) {
  const m = new ScratchManager({
    maxWorkspaces: 4,
    maxRows: 1_000,
    maxTables: 3,
    ttlMinutes: 60,
    statementTimeoutMs: 5_000,
    sweepIntervalMs: 0,
    ...overrides,
  });
  managers.push(m);
  return m;
}

afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.closeAll()));
});

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!isAppError(e)) throw new Error(`expected an AppError, got ${String(e)}`);
  return e.code;
}

describe('ScratchManager', () => {
  it('runs temp table DDL and DML and joins scratch tables', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('CREATE TEMP TABLE tmp_a (id int, name text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'um'), (2, 'dois'), (3, 'tres')");
    await ws.exec('CREATE TABLE tmp_b (id int, score numeric)');
    await ws.exec('INSERT INTO tmp_b VALUES (1, 10), (2, 20)');
    const upd = await ws.exec("UPDATE tmp_a SET name = 'UM' WHERE id = 1");
    expect(upd).toMatchObject({ command: 'UPDATE', rowCount: 1 });
    const del = await ws.exec('DELETE FROM tmp_a WHERE id = 3');
    expect(del.rowCount).toBe(1);
    await ws.exec('ALTER TABLE tmp_a ADD COLUMN note text');
    const joined = await ws.exec(
      'SELECT a.name, b.score FROM tmp_a a JOIN tmp_b b ON a.id = b.id ORDER BY a.id',
    );
    expect(joined.columns).toEqual(['name', 'score']);
    expect(joined).toMatchObject({ command: 'SELECT', rowCount: 2 });
    expect(joined.rows).toEqual([
      ['UM', '10'],
      ['dois', '20'],
    ]);
    await ws.exec('DROP TABLE tmp_b');
    expect(await ws.tables()).toEqual([{ name: 'tmp_a', rows: 2 }]);
  });

  it("isolates users: B cannot see A's tables", async () => {
    const m = manager();
    const a = await m.workspace('user-a');
    const b = await m.workspace('user-b');
    await a.exec('CREATE TEMP TABLE tmp_a (id int)');
    await a.exec('INSERT INTO tmp_a VALUES (1)');
    const missing = await b.exec('SELECT * FROM tmp_a').then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(missing).toMatchObject({ code: 'VALIDATION_ERROR', details: { sqlState: '42P01' } });
    expect(await b.tables()).toEqual([]);
    // Same name, separate data.
    await b.exec('CREATE TEMP TABLE tmp_a (id int)');
    await b.exec('INSERT INTO tmp_a VALUES (2), (3)');
    expect((await a.exec('SELECT id FROM tmp_a ORDER BY id')).rows).toEqual([[1]]);
    expect((await b.exec('SELECT id FROM tmp_a ORDER BY id')).rows).toEqual([[2], [3]]);
  });

  it('refuses table names without the tmp_ prefix', async () => {
    const ws = await manager().workspace('u1');
    expect(await codeOf(ws.exec('CREATE TABLE clientes (id int)'))).toBe('VALIDATION_ERROR');
    expect(await codeOf(ws.exec('SELECT * FROM pg_catalog.pg_tables'))).toBe('VALIDATION_ERROR');
  });

  it('enforces the table quota', async () => {
    const ws = await manager({ maxTables: 2 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_1 (id int)');
    await ws.exec('CREATE TABLE tmp_2 (id int)');
    expect(await codeOf(ws.exec('CREATE TABLE tmp_3 (id int)'))).toBe('QUERY_LIMIT_EXCEEDED');
    expect((await ws.tables()).map((t) => t.name)).toEqual(['tmp_1', 'tmp_2']);
  });

  it('rolls back a statement that exceeds the row quota', async () => {
    const ws = await manager({ maxRows: 100 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (g int)');
    await ws.exec('INSERT INTO tmp_a SELECT g FROM generate_series(1, 60) g');
    expect(await codeOf(ws.exec('INSERT INTO tmp_a SELECT g FROM generate_series(1, 60) g'))).toBe(
      'QUERY_LIMIT_EXCEEDED',
    );
    expect(await ws.tables()).toEqual([{ name: 'tmp_a', rows: 60 }]);
  });

  it('checks the row quota across tables after every mutating statement', async () => {
    const ws = await manager({ maxRows: 100 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (g int)');
    await ws.exec('INSERT INTO tmp_a SELECT g FROM generate_series(1, 80) g');
    await ws.exec('CREATE TABLE tmp_b (g int)');
    expect(await codeOf(ws.exec('INSERT INTO tmp_b SELECT g FROM generate_series(1, 30) g'))).toBe(
      'QUERY_LIMIT_EXCEEDED',
    );
    // An import is a mutation too: it is refused and the previous table survives.
    expect(
      await codeOf(
        ws.importRows(
          'tmp_a',
          [{ name: 'g', type: 'numeric' }],
          Array.from({ length: 101 }, (_, i) => [i]),
        ),
      ),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect(
      await codeOf(
        ws.importRows(
          'tmp_c',
          [{ name: 'g', type: 'numeric' }],
          Array.from({ length: 30 }, (_, i) => [i]),
        ),
      ),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect(await ws.tables()).toEqual([
      { name: 'tmp_a', rows: 80 },
      { name: 'tmp_b', rows: 0 },
    ]);
    expect((await ws.exec('SELECT 1 AS one')).rows).toEqual([[1]]);
  }, 60_000);

  it('evicts idle workspaces after the TTL', async () => {
    let now = 0;
    const m = manager({ ttlMinutes: 10, now: () => now });
    const ws = await m.workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int)');
    now += 9 * 60_000;
    expect(await m.evictIdle()).toBe(0);
    now += 2 * 60_000;
    expect(await m.evictIdle()).toBe(1);
    expect(m.stats()).toEqual({ workspaces: 0 });
    const fresh = await m.workspace('u1');
    expect(await fresh.tables()).toEqual([]);
  });

  it('an evicted workspace refuses further use instead of starting an untracked database', async () => {
    let now = 0;
    const m = manager({ ttlMinutes: 1, maxWorkspaces: 1, now: () => now });
    const stale = await m.workspace('u1');
    await stale.exec('SELECT 1');
    now += 2 * 60_000;
    expect(await m.evictIdle()).toBe(1);
    expect(await codeOf(stale.exec('SELECT 1'))).toBe('NOT_FOUND');
    expect(await codeOf(stale.tables())).toBe('NOT_FOUND');
    // The slot is free for another user.
    await m.workspace('u2');
    expect(m.stats()).toEqual({ workspaces: 1 });
  });

  it('concurrent requests for one user share a single workspace', async () => {
    let now = 0;
    const m = manager({ ttlMinutes: 1, maxWorkspaces: 1, now: () => now });
    await m.workspace('old');
    now += 2 * 60_000;
    // At capacity: both calls wait on eviction; they must not create two workspaces.
    const [a, b] = await Promise.all([m.workspace('u1'), m.workspace('u1')]);
    expect(a).toBe(b);
    expect(m.stats()).toEqual({ workspaces: 1 });
  });

  it('discard rejects a queued op and leaves no live worker (F1)', async () => {
    const m = manager();
    const ws = await m.workspace('u1');
    await ws.exec('SELECT 1');
    const running = codeOf(ws.exec('SELECT count(*) FROM generate_series(1, 50000000) g'));
    const queued = codeOf(ws.exec('SELECT 42 AS n'));
    await m.discard('u1');
    expect(await running).toBe('NOT_FOUND');
    expect(await queued).toBe('NOT_FOUND');
    expect(ws.workerAlive()).toBe(false);
  }, 60_000);

  it('closeAll rejects queued ops and refuses new workspaces (F1, F8)', async () => {
    const m = manager();
    const ws = await m.workspace('u1');
    const queued = [codeOf(ws.exec('SELECT 1')), codeOf(ws.exec('SELECT 2'))];
    await m.closeAll();
    for (const p of queued) expect(await p).toBe('NOT_FOUND');
    expect(ws.workerAlive()).toBe(false);
    expect(await codeOf(m.workspace('u2'))).toBe('NOT_FOUND');
  }, 60_000);

  it('refuses a result larger than maxResultBytes instead of shipping it (F2)', async () => {
    const ws = await manager({ maxResultBytes: 10_000 }).workspace('u1');
    expect(await codeOf(ws.exec("SELECT repeat('x', 1000) FROM generate_series(1, 20)"))).toBe(
      'QUERY_LIMIT_EXCEEDED',
    );
    expect((await ws.exec("SELECT repeat('x', 100) AS s")).rows).toHaveLength(1);
    await ws.exec('CREATE TABLE tmp_a (v text)');
    await ws.exec("INSERT INTO tmp_a SELECT repeat('y', 1000) FROM generate_series(1, 20)");
    expect(
      await codeOf(ws.transactionalDryRun("UPDATE tmp_a SET v = 'z' WHERE id IS NOT NULL")),
    ).toBe('QUERY_LIMIT_EXCEEDED');
  }, 60_000);

  it('rolls back a write whose RETURNING result passes maxResultBytes (R1)', async () => {
    const ws = await manager({ maxResultBytes: 10_000 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (v text)');
    expect(
      await codeOf(
        ws.exec(
          'INSERT INTO tmp_a SELECT md5(g::text) FROM generate_series(1, 1000) g RETURNING v',
        ),
      ),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect((await ws.exec('SELECT count(*)::int AS n FROM tmp_a')).rows).toEqual([[0]]);
  }, 60_000);

  it('enforces the storage quota in bytes and rolls back (F3)', async () => {
    const ws = await manager({ maxBytes: 200_000, maxRows: 1_000_000 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (v text)');
    expect(
      await codeOf(
        ws.exec('INSERT INTO tmp_a SELECT md5(g::text) FROM generate_series(1, 20000) g'),
      ),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect(await ws.tables()).toEqual([{ name: 'tmp_a', rows: 0 }]);
  }, 60_000);

  it('recycles a worker whose wasm memory passes the ceiling (F3)', async () => {
    const ws = await manager({ maxWasmMemoryBytes: 1 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int)');
    // The worker was recycled after the statement, so the workspace starts empty again.
    expect(await ws.tables()).toEqual([]);
  }, 60_000);

  it('the deadline includes time spent in the queue (F4)', async () => {
    const ws = await manager({ statementTimeoutMs: 1_500 }).workspace('u1');
    await ws.exec('SELECT 1');
    const started = Date.now();
    const runaway = codeOf(ws.exec('SELECT count(*) FROM generate_series(1, 1000000000) g'));
    const queued = codeOf(ws.exec('SELECT count(*) FROM generate_series(1, 1000000000) g'));
    expect(await runaway).toBe('QUERY_TIMEOUT');
    expect(await queued).toBe('QUERY_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(1_500 + 2_000);
  }, 60_000);

  it('a queued op observes its abort signal while waiting (F4)', async () => {
    const ws = await manager({ statementTimeoutMs: 10_000 }).workspace('u1');
    await ws.exec('SELECT 1');
    const runaway = ws.exec('SELECT count(*) FROM generate_series(1, 1000000000) g');
    const controller = new AbortController();
    const queued = ws.exec('SELECT 1', controller.signal);
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    expect(await codeOf(queued)).toBe('QUERY_CANCELLED');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await codeOf(runaway)).toBe('QUERY_TIMEOUT');
  }, 60_000);

  it('observes the abort signal while the worker starts (F4)', async () => {
    const ws = await manager().workspace('u1');
    const controller = new AbortController();
    const p = ws.exec('SELECT 1', controller.signal);
    setTimeout(() => controller.abort(), 5);
    expect(await codeOf(p)).toBe('QUERY_CANCELLED');
    expect((await ws.exec('SELECT 2 AS two')).rows).toEqual([[2]]);
  }, 60_000);

  it('caps the queue at 4 waiting ops per workspace (F4)', async () => {
    const ws = await manager({ statementTimeoutMs: 3_000 }).workspace('u1');
    await ws.exec('SELECT 1');
    const runaway = ws.exec('SELECT count(*) FROM generate_series(1, 1000000000) g');
    const waiting = [1, 2, 3, 4].map(() => ws.exec('SELECT 1'));
    expect(await codeOf(ws.exec('SELECT 1'))).toBe('RATE_LIMITED');
    await Promise.allSettled([runaway, ...waiting]);
  }, 60_000);

  it('maps PostgreSQL resource errors to QUERY_LIMIT_EXCEEDED (F7)', async () => {
    const ws = await manager().workspace('u1');
    // SQLSTATE 54000 (program_limit_exceeded): requested length too large.
    expect(await codeOf(ws.exec("SELECT repeat('x', 1100000000)"))).toBe('QUERY_LIMIT_EXCEEDED');
  }, 60_000);

  it('refuses an empty user id', async () => {
    expect(await codeOf(manager().workspace(''))).toBe('VALIDATION_ERROR');
  });

  it('returns RATE_LIMITED when every workspace is taken', async () => {
    const m = manager({ maxWorkspaces: 2 });
    await m.workspace('a');
    await m.workspace('b');
    expect(await codeOf(m.workspace('c'))).toBe('RATE_LIMITED');
  });

  it('refuses COPY, CREATE FUNCTION, DO and dangerous functions', async () => {
    const ws = await manager().workspace('u1');
    for (const sql of [
      'COPY tmp_a FROM stdin',
      'CREATE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql',
      'DO $$ begin end $$',
      'SELECT pg_sleep(10)',
      "SELECT current_setting('data_directory')",
      "SELECT query_to_xml('select 1', true, true, '')",
      'SELECT 1; SELECT 2',
      'BEGIN',
      'CREATE EXTENSION dblink',
      'LISTEN x',
      "NOTIFY x, 'y'",
      "SELECT lo_import('/etc/passwd')",
      "SELECT dblink('a', 'b')",
      "SELECT set_config('search_path', 'x', false)",
    ]) {
      expect(['SQL_PARSE_ERROR', 'SQL_UNSUPPORTED', 'SQL_FORBIDDEN']).toContain(
        await codeOf(ws.exec(sql)),
      );
    }
  });

  it('a transactional dry run shows before/after and leaves the data unchanged', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int, v text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'x'), (2, 'y')");
    const dry = await ws.transactionalDryRun("UPDATE tmp_a SET v = 'z' WHERE id = 2");
    expect(dry.table).toBe('tmp_a');
    expect(dry.rowCount).toBe(1);
    expect(dry.before.rows).toContainEqual([2, 'y']);
    expect(dry.after.rows).toContainEqual([2, 'z']);
    const now = await ws.exec('SELECT v FROM tmp_a WHERE id = 2');
    expect(now.rows).toEqual([['y']]);
  });

  it('reads never keep side effects', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int)');
    await ws.exec('INSERT INTO tmp_a VALUES (1), (2)');
    // The guard refuses this; bypass it to exercise the worker's ROLLBACK-for-reads path.
    const res = await ws.execStatement({
      command: 'SELECT',
      action: 'QUERY.SELECT',
      sql: 'WITH d AS (DELETE FROM tmp_a RETURNING id) SELECT * FROM d',
      tables: ['tmp_a'],
      target: null,
      mutating: false,
      hasWhere: true,
    });
    expect(res.rowCount).toBe(2);
    expect(await ws.tables()).toEqual([{ name: 'tmp_a', rows: 2 }]);
  });

  it('importRows creates the table and validates names', async () => {
    const ws = await manager().workspace('u1');
    await ws.importRows(
      'tmp_par',
      [
        { name: 'codparc', type: 'numeric' },
        { name: 'nomeparc', type: 'text' },
        { name: 'ativo', type: 'boolean' },
      ],
      [
        [1, 'Alfa', true],
        [2, 'Beta', false],
      ],
    );
    const res = await ws.exec('SELECT nomeparc FROM tmp_par WHERE ativo ORDER BY codparc');
    expect(res.rows).toEqual([['Alfa']]);
    await expect(ws.importRows('par', [{ name: 'a', type: 'text' }], [])).rejects.toBeInstanceOf(
      AppError,
    );
    expect(await codeOf(ws.importRows('tmp_x', [{ name: 'a"b', type: 'text' }], []))).toBe(
      'VALIDATION_ERROR',
    );
  });

  // Review Focus #5: a runaway statement stops at the timeout and the API stays responsive.
  it('a runaway INSERT … generate_series stops at the timeout without blocking the API', async () => {
    const m = manager({ statementTimeoutMs: 1_500, maxRows: 10_000_000 });
    const ws = await m.workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (g bigint)');
    let ticks = 0;
    const ticker = setInterval(() => (ticks += 1), 50);
    const started = Date.now();
    const code = await codeOf(
      ws.exec('INSERT INTO tmp_a SELECT g FROM generate_series(1, 1000000000) g'),
    );
    const elapsed = Date.now() - started;
    clearInterval(ticker);
    expect(['QUERY_TIMEOUT', 'QUERY_LIMIT_EXCEEDED']).toContain(code);
    expect(elapsed).toBeLessThan(1_500 + 2_000);
    expect(ticks).toBeGreaterThan(10);
    const after = await ws.exec('SELECT 1 AS one');
    expect(after.rows).toEqual([[1]]);
  }, 60_000);

  it('a cancelled statement is reported as cancelled', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('SELECT 1');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    expect(
      await codeOf(
        ws.exec('SELECT count(*) FROM generate_series(1, 1000000000) g', controller.signal),
      ),
    ).toBe('QUERY_CANCELLED');
    expect((await ws.exec('SELECT 2 AS two')).rows).toEqual([[2]]);
  }, 60_000);
  it('dry-runs CREATE, ALTER and DROP: structure before and after, nothing kept', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int, name text)');
    await ws.exec("INSERT INTO tmp_a VALUES (1, 'um'), (2, 'dois')");
    const stmt = (sql: string) => analyzeScratchSql(sql);

    const ctas = await ws.ddlDryRun(
      stmt('CREATE TABLE tmp_b AS SELECT id FROM tmp_a WHERE id > 1'),
    );
    expect(ctas).toEqual({
      table: 'tmp_b',
      before: null,
      after: { name: 'tmp_b', rows: 1, columns: [{ name: 'id', type: 'integer' }] },
    });
    const alter = await ws.ddlDryRun(stmt('ALTER TABLE tmp_a ADD COLUMN score numeric(10,2)'));
    expect(alter.before?.columns.map((c) => c.name)).toEqual(['id', 'name']);
    expect(alter.after).toEqual({
      name: 'tmp_a',
      rows: 2,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'text' },
        { name: 'score', type: 'numeric(10,2)' },
      ],
    });
    const drop = await ws.ddlDryRun(stmt('DROP TABLE tmp_a'));
    expect(drop.before?.rows).toBe(2);
    expect(drop.after).toBeNull();

    // Rolled back: the workspace is exactly as before.
    expect(await ws.describe()).toEqual([
      {
        name: 'tmp_a',
        rows: 2,
        columns: [
          { name: 'id', type: 'integer' },
          { name: 'name', type: 'text' },
        ],
      },
    ]);
  });

  it('refuses at the dry run a CREATE … AS SELECT that would pass the quotas', async () => {
    const ws = await manager({ maxRows: 3 }).workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int)');
    await ws.exec('INSERT INTO tmp_a VALUES (1), (2)');
    expect(
      await codeOf(ws.ddlDryRun(analyzeScratchSql('CREATE TABLE tmp_b AS SELECT * FROM tmp_a'))),
    ).toBe('QUERY_LIMIT_EXCEEDED');
    expect((await ws.describe()).map((t) => t.name)).toEqual(['tmp_a']);
  });

  it('a structure dry run needs a DDL statement', async () => {
    const ws = await manager().workspace('u1');
    await ws.exec('CREATE TABLE tmp_a (id int)');
    expect(await codeOf(ws.ddlDryRun(analyzeScratchSql('DELETE FROM tmp_a WHERE id = 1')))).toBe(
      'VALIDATION_ERROR',
    );
  });
});
