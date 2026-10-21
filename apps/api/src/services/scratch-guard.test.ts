import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { analyzeScratchSql } from './scratch-guard';

function codeOf(sql: string): string {
  try {
    analyzeScratchSql(sql);
  } catch (e) {
    if (isAppError(e)) return e.code;
    throw e;
  }
  return 'OK';
}

describe('analyzeScratchSql', () => {
  it.each([
    ['SELECT * FROM tmp_a', 'SELECT', 'QUERY.SELECT', null],
    ['CREATE TEMP TABLE tmp_a (id int)', 'CREATE TABLE', 'TEMP.CREATE', 'tmp_a'],
    ['CREATE TABLE tmp_a (id int)', 'CREATE TABLE', 'TEMP.CREATE', 'tmp_a'],
    ['INSERT INTO tmp_a VALUES (1)', 'INSERT', 'TEMP.WRITE', 'tmp_a'],
    ['UPDATE tmp_a SET id = 2 WHERE id = 1', 'UPDATE', 'TEMP.WRITE', 'tmp_a'],
    ['DELETE FROM tmp_a WHERE id = 1', 'DELETE', 'TEMP.WRITE', 'tmp_a'],
    ['ALTER TABLE tmp_a ADD COLUMN n text', 'ALTER TABLE', 'TEMP.CREATE', 'tmp_a'],
    ['DROP TABLE tmp_a', 'DROP TABLE', 'TEMP.DROP', 'tmp_a'],
  ])('classifies %s', (sql, command, action, target) => {
    const stmt = analyzeScratchSql(sql);
    expect(stmt).toMatchObject({ command, action, target, mutating: command !== 'SELECT' });
    expect(stmt.tables).toContain('tmp_a');
  });

  it.each([
    'UPDATE tmp_a SET id = 2',
    'DELETE FROM tmp_a',
    'UPDATE tmp_a SET id = 2 WHERE 1 = 1',
    'DELETE FROM tmp_a WHERE id = id',
    'DELETE FROM tmp_a WHERE id = 1 OR 2 > 1',
  ])('refuses %s as WHERE_REQUIRED, like the planned scratch path', (sql) => {
    expect(codeOf(sql)).toBe('WHERE_REQUIRED');
  });

  it('accepts UPDATE and DELETE with a WHERE that restricts rows, and reports it', () => {
    expect(analyzeScratchSql('UPDATE tmp_a SET n = n + 1 WHERE id > 10')).toMatchObject({
      command: 'UPDATE',
      hasWhere: true,
    });
    expect(analyzeScratchSql('DELETE FROM tmp_a WHERE id = 1 AND 1 = 1')).toMatchObject({
      command: 'DELETE',
      hasWhere: true,
    });
    // INSERT has no WHERE to give: the policy engine is told it needs none.
    expect(analyzeScratchSql('INSERT INTO tmp_a VALUES (1)').hasWhere).toBe(true);
  });

  it('allows CTEs and joins between scratch tables', () => {
    const stmt = analyzeScratchSql(
      'WITH x AS (SELECT id FROM tmp_a) SELECT * FROM x JOIN tmp_b ON x.id = tmp_b.id',
    );
    expect(stmt.tables).toEqual(['tmp_a', 'tmp_b']);
  });

  it('creates a plain scratch table for CREATE TEMPORARY / TEMP TABLE', () => {
    for (const sql of [
      'CREATE TEMPORARY TABLE tmp_x AS SELECT id FROM tmp_a',
      'CREATE TEMP TABLE tmp_x (id int)',
    ]) {
      const stmt = analyzeScratchSql(sql);
      expect(stmt.command).toBe('CREATE TABLE');
      expect(stmt.target).toBe('tmp_x');
      expect(stmt.sql).not.toMatch(/TEMP/i);
    }
  });

  it('executes the regenerated SQL, not the input', () => {
    const stmt = analyzeScratchSql('select   1  -- comment');
    expect(stmt.sql).not.toContain('comment');
  });

  it.each([
    ['SELECT * FROM tgfpar', 'VALIDATION_ERROR'],
    ['SELECT * FROM pg_catalog.pg_tables', 'VALIDATION_ERROR'],
    ['CREATE TABLE TMP_A (id int)', 'VALIDATION_ERROR'],
    ['INSERT INTO tmp_a SELECT * FROM tgfpar', 'VALIDATION_ERROR'],
    ['SELECT 1; SELECT 2', 'SQL_UNSUPPORTED'],
    ['CREATE FUNCTION f() RETURNS int AS $$ select 1 $$ LANGUAGE sql', 'SQL_UNSUPPORTED'],
    ['SELECT pg_sleep(1)', 'SQL_FORBIDDEN'],
    ["SELECT set_config('a', 'b', false)", 'SQL_FORBIDDEN'],
    ["SELECT query_to_xml('select 1', true, true, '')", 'SQL_FORBIDDEN'],
    ['CREATE INDEX i ON tmp_a (id)', 'SQL_UNSUPPORTED'],
  ])('refuses %s', (sql, code) => {
    expect(codeOf(sql)).toBe(code);
  });

  it.each(['COPY tmp_a FROM stdin', 'DO $$ begin end $$', 'not sql at all'])(
    'refuses %s as unparseable or unsupported',
    (sql) => {
      expect(['SQL_PARSE_ERROR', 'SQL_UNSUPPORTED']).toContain(codeOf(sql));
    },
  );

  it.each([
    // Every table a DDL statement touches must be a scratch table, not only its target.
    ['ALTER TABLE tmp_a RENAME TO clientes', 'VALIDATION_ERROR'],
    ['CREATE TEMP TABLE tmp_b (id int REFERENCES clientes (id))', 'VALIDATION_ERROR'],
    ['CREATE TABLE tmp_b AS SELECT * FROM tgfpar', 'VALIDATION_ERROR'],
    // Deny list (brief): pg_*, dblink*, lo_*, copy, set_config, current_setting.
    ["SELECT * FROM pg_ls_dir('.')", 'SQL_FORBIDDEN'],
    ["SELECT dblink_connect('x')", 'SQL_FORBIDDEN'],
    ["SELECT lo_import('/etc/passwd')", 'SQL_FORBIDDEN'],
    ['SELECT copy(1)', 'SQL_FORBIDDEN'],
    ['SELECT "PG_SLEEP"(1)', 'SQL_FORBIDDEN'],
    ["SELECT current_setting('data_directory')", 'SQL_FORBIDDEN'],
    ['INSERT INTO tmp_a VALUES (1) RETURNING pg_backend_pid()', 'SQL_FORBIDDEN'],
    ['CREATE TABLE tmp_a (id int DEFAULT pg_backend_pid())', 'SQL_FORBIDDEN'],
    ['SELECT loread(0, 1)', 'SQL_FORBIDDEN'],
    ["SELECT lowrite(0, 'x')", 'SQL_FORBIDDEN'],
    // sqlify would mangle these (F6): CASCADE/RESTRICT become an alias, parameters and variables.
    ['DROP TABLE tmp_a CASCADE', 'SQL_UNSUPPORTED'],
    ['DROP TABLE tmp_a RESTRICT', 'SQL_UNSUPPORTED'],
    ['SELECT :x', 'SQL_UNSUPPORTED'],
    ['SELECT @@version', 'SQL_UNSUPPORTED'],
    ['SELECT @x', 'SQL_UNSUPPORTED'],
    ['SELECT $1', 'SQL_UNSUPPORTED'],
    ['SELECT * FROM tmp_a WHERE id = :id', 'SQL_UNSUPPORTED'],
    ['SELECT 1 FROM tmp_a t(pg_sleep)', 'SQL_UNSUPPORTED'],
    // Statements the sql-engine classifier does not recognise are refused (fail closed).
    ['CREATE EXTENSION dblink', 'SQL_UNSUPPORTED'],
    ['WITH d AS (DELETE FROM tmp_a RETURNING id) SELECT * FROM d', 'SQL_UNSUPPORTED'],
    ['TRUNCATE tmp_a', 'SQL_UNSUPPORTED'],
    ['SET search_path = x', 'SQL_UNSUPPORTED'],
    ['', 'SQL_UNSUPPORTED'],
  ])('refuses %s', (sql, code) => {
    expect(codeOf(sql)).toBe(code);
  });

  it.each(['LISTEN x', 'NOTIFY x', 'UNLISTEN *', 'VACUUM', 'SELECT TOP 1 * FROM tmp_a'])(
    'refuses %s (classifier or PostgreSQL parse)',
    (sql) => {
      expect(['SQL_PARSE_ERROR', 'SQL_UNSUPPORTED']).toContain(codeOf(sql));
    },
  );

  it.each([
    'SELECT a.id, b.v FROM tmp_a a JOIN tmp_b AS b ON a.id = b.id WHERE a.id > 1 ORDER BY 1',
    'WITH x AS (SELECT id FROM tmp_a) SELECT * FROM x',
    "INSERT INTO tmp_a (id, v) VALUES (1, 'x')",
    'UPDATE tmp_a SET v = upper(v) WHERE id = 1',
    'CREATE TEMP TABLE tmp_c AS SELECT * FROM tmp_a',
    'ALTER TABLE tmp_a ADD COLUMN n text',
    'DROP TABLE tmp_a',
    'SELECT $$a;b$$ AS s',
  ])('the regenerated SQL is a fixed point: %s', (sql) => {
    const first = analyzeScratchSql(sql);
    expect(analyzeScratchSql(first.sql)).toEqual(first);
  });

  it('refuses oversized statements', () => {
    expect(codeOf(`SELECT '${'x'.repeat(100_001)}'`)).toBe('QUERY_LIMIT_EXCEEDED');
  });

  describe('columns of a SELECT', () => {
    const cols = (sql: string) => analyzeScratchSql(sql).columns;

    it('attributes qualified columns to their table and unqualified ones to every table', () => {
      expect(cols('SELECT a.email, nome FROM tmp_a a JOIN tmp_b b ON a.id = b.id')).toEqual(
        expect.arrayContaining([
          { table: 'tmp_a', name: 'email' },
          { table: 'tmp_a', name: 'nome' },
          { table: 'tmp_b', name: 'nome' },
          { table: 'tmp_a', name: 'id' },
          { table: 'tmp_b', name: 'id' },
        ]),
      );
      expect(cols('SELECT "email" FROM tmp_a')).toEqual([{ table: 'tmp_a', name: 'email' }]);
      expect(cols('SELECT a.email FROM tmp_a a JOIN tmp_b b ON true')).not.toContainEqual({
        table: 'tmp_b',
        name: 'email',
      });
    });

    it('reads every column for a star or a whole-row reference, but not for COUNT(*)', () => {
      expect(cols('SELECT count(*) FROM tmp_a')).toEqual([]);
      expect(cols('SELECT * FROM tmp_a')).toEqual([{ table: 'tmp_a', name: '*' }]);
      expect(cols('SELECT b.* FROM tmp_a a JOIN tmp_b b ON true')).toEqual([
        { table: 'tmp_b', name: '*' },
      ]);
      expect(cols('SELECT row_to_json(a) FROM tmp_a a')).toEqual([{ table: 'tmp_a', name: '*' }]);
      expect(cols('SELECT tmp_a FROM tmp_a')).toEqual([{ table: 'tmp_a', name: '*' }]);
      expect(cols('SELECT count(*) FROM (SELECT * FROM tmp_a) x')).toEqual([
        { table: 'tmp_a', name: '*' },
      ]);
    });

    it('attributes CTE and derived-table columns to every table', () => {
      expect(
        cols('WITH c AS (SELECT id FROM tmp_a) SELECT c.id FROM c JOIN tmp_b ON true'),
      ).toEqual(
        expect.arrayContaining([
          { table: 'tmp_a', name: 'id' },
          { table: 'tmp_b', name: 'id' },
        ]),
      );
      expect(cols('SELECT to_json(c) FROM (SELECT id FROM tmp_a) c')).toContainEqual({
        table: 'tmp_a',
        name: '*',
      });
    });

    it('reads USING columns on every table and every column of a NATURAL JOIN', () => {
      const using = cols('SELECT id FROM tmp_p JOIN tmp_q USING (email)');
      expect(using).toContainEqual({ table: 'tmp_p', name: 'email' });
      expect(using).toContainEqual({ table: 'tmp_q', name: 'email' });
      for (const sql of [
        'SELECT id FROM tmp_p NATURAL JOIN tmp_q',
        'SELECT id FROM tmp_p natural LEFT JOIN tmp_q',
      ]) {
        const c = analyzeScratchSql(sql);
        for (const t of c.tables) expect(c.columns, sql).toContainEqual({ table: t, name: '*' });
      }
    });

    it('is left undefined for statements other than SELECT', () => {
      expect(analyzeScratchSql('INSERT INTO tmp_a SELECT id FROM tmp_b').columns).toBeUndefined();
      expect(analyzeScratchSql('UPDATE tmp_a SET id = 2 WHERE id = 1').columns).toBeUndefined();
    });
  });
});
