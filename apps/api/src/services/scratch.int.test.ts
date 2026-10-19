import { afterEach, describe, expect, it } from 'vitest';
import { AppError, isAppError } from '@dbx/shared';
import { ScratchManager, type ScratchManagerOptions } from './scratch';

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
    expect(await codeOf(b.exec('SELECT * FROM tmp_a'))).toBe('VALIDATION_ERROR');
    expect(await b.tables()).toEqual([]);
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
    await ws
      .exec('WITH d AS (DELETE FROM tmp_a RETURNING id) SELECT * FROM d')
      .catch(() => undefined);
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
});
