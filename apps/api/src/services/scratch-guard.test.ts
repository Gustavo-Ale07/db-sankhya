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
    ['UPDATE tmp_a SET id = 2', 'UPDATE', 'TEMP.WRITE', 'tmp_a'],
    ['DELETE FROM tmp_a WHERE id = 1', 'DELETE', 'TEMP.WRITE', 'tmp_a'],
    ['ALTER TABLE tmp_a ADD COLUMN n text', 'ALTER TABLE', 'TEMP.CREATE', 'tmp_a'],
    ['DROP TABLE tmp_a', 'DROP TABLE', 'TEMP.DROP', 'tmp_a'],
  ])('classifies %s', (sql, command, action, target) => {
    const stmt = analyzeScratchSql(sql);
    expect(stmt).toMatchObject({ command, action, target, mutating: command !== 'SELECT' });
    expect(stmt.tables).toContain('tmp_a');
  });

  it('allows CTEs and joins between scratch tables', () => {
    const stmt = analyzeScratchSql(
      'WITH x AS (SELECT id FROM tmp_a) SELECT * FROM x JOIN tmp_b ON x.id = tmp_b.id',
    );
    expect(stmt.tables).toEqual(['tmp_a', 'tmp_b']);
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

  it('refuses oversized statements', () => {
    expect(codeOf(`SELECT '${'x'.repeat(100_001)}'`)).toBe('QUERY_LIMIT_EXCEEDED');
  });
});
