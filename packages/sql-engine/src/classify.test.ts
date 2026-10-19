import { describe, expect, it } from 'vitest';
import { classifyStatement } from './classify';

describe('classifyStatement', () => {
  it('classifies a DELETE with leading whitespace', () => {
    const c = classifyStatement(' DELETE FROM T WHERE A=1');
    expect(c).toMatchObject({ kind: 'DELETE', table: 'T', hasWhere: true });
  });

  it('accepts comments and classifies UPDATE from the AST', () => {
    const c = classifyStatement('/* x */ UPDATE T SET A=1 WHERE B=2');
    expect(c).toMatchObject({ kind: 'UPDATE', table: 'T', hasWhere: true });
    expect(c.kind === 'UPDATE' && c.stmt?.type).toBe('update');
  });

  it('flags UPDATE / DELETE without WHERE', () => {
    expect(classifyStatement('UPDATE T SET A=1')).toMatchObject({
      kind: 'UPDATE',
      hasWhere: false,
    });
    expect(classifyStatement('DELETE FROM T')).toMatchObject({ kind: 'DELETE', hasWhere: false });
  });

  it('detects temporary tables', () => {
    expect(classifyStatement('CREATE TEMPORARY TABLE tmp_x (a int)')).toMatchObject({
      kind: 'CREATE_TABLE',
      table: 'tmp_x',
      temporary: true,
    });
    expect(classifyStatement('CREATE TABLE AD_X (A INT)')).toMatchObject({
      kind: 'CREATE_TABLE',
      table: 'AD_X',
      temporary: false,
    });
  });

  it('records the source tables of CTAS and INSERT … SELECT', () => {
    expect(classifyStatement('CREATE TEMP TABLE tmp_a AS SELECT A FROM TGFPAR')).toMatchObject({
      kind: 'CREATE_TABLE',
      temporary: true,
      sourceTables: ['TGFPAR'],
    });
    const c = classifyStatement('INSERT INTO tmp_a (A) SELECT A FROM TGFPAR');
    expect(c).toMatchObject({ kind: 'INSERT', table: 'tmp_a', sourceTables: ['TGFPAR'] });
    expect(c.kind === 'INSERT' && c.stmt).toBeUndefined();
    expect(c.kind === 'INSERT' && c.stmtError).toMatch(/SELECT/);
  });

  it('builds the write AST for a single-row INSERT', () => {
    const c = classifyStatement("INSERT INTO TGFPAR (CODPARC, NOMEPARC) VALUES (1, 'Fulano')");
    expect(c.kind === 'INSERT' && c.stmt).toMatchObject({
      type: 'insert',
      columns: ['codparc', 'nomeparc'],
    });
  });

  it('classifies ALTER and DROP', () => {
    expect(classifyStatement('ALTER TABLE AD_X ADD COLUMN B INT')).toMatchObject({
      kind: 'ALTER_TABLE',
      table: 'AD_X',
    });
    expect(classifyStatement('DROP TABLE tmp_a')).toMatchObject({
      kind: 'DROP_TABLE',
      table: 'tmp_a',
    });
  });

  it('classifies SELECT, including T-SQL syntax, and excludes CTE names', () => {
    expect(classifyStatement('SELECT TOP 5 * FROM TGFPAR')).toEqual({
      kind: 'SELECT',
      tables: ['TGFPAR'],
    });
    expect(
      classifyStatement('WITH x AS (SELECT CODPARC FROM TGFPAR) SELECT * FROM x JOIN tmp_a ON 1=1'),
    ).toEqual({ kind: 'SELECT', tables: ['TGFPAR', 'tmp_a'] });
  });

  it.each([
    'DELETE FROM T; DROP TABLE T',
    'GRANT SELECT ON T TO bob',
    'TRUNCATE TABLE T',
    'SELECT * INTO T2 FROM T',
    'SELECT * FROM T FOR UPDATE',
    'DROP TABLE A, B',
    'UPDATE T SET A=1 FROM U WHERE T.B=U.B',
    'CREATE INDEX i ON T (A)',
    'CREATE VIEW v AS SELECT 1',
    'not sql at all',
    '',
  ])('returns UNKNOWN for %s', (sql) => {
    expect(classifyStatement(sql).kind).toBe('UNKNOWN');
  });

  describe('CTE scoping', () => {
    it.each([
      // The CTE body reads the real table it shadows.
      'WITH TGFPAR AS (SELECT * FROM TGFPAR) SELECT * FROM TGFPAR',
      // Same through the T-SQL fallback.
      'WITH TGFPAR AS (SELECT TOP 1 * FROM TGFPAR) SELECT * FROM TGFPAR',
      // Recursive-looking self reference.
      'WITH RECURSIVE x AS (SELECT 1 A UNION ALL SELECT A FROM x) SELECT A FROM x',
      // An earlier CTE body reads the real table a later CTE is named after.
      'WITH a AS (SELECT A FROM TGFPAR), TGFPAR AS (SELECT 1 A) SELECT * FROM a',
      // A CTE in a derived table hides the real table elsewhere.
      'SELECT q.A FROM (WITH TGFPAR AS (SELECT 1 A) SELECT A FROM TGFPAR) q JOIN TGFPAR P ON P.A = q.A',
      'SELECT A FROM (WITH TGFPAR AS (SELECT 1 A) SELECT A FROM TGFPAR) q UNION SELECT A FROM TGFPAR',
      // Duplicate CTE names (case-insensitive).
      'WITH x AS (SELECT 1 A), X AS (SELECT 2 A) SELECT A FROM x',
      // Writes: a CTE may not shadow the target or a source table.
      'WITH tmp_a AS (SELECT A FROM TGFPAR) UPDATE tmp_a SET A = 1 WHERE A = 2',
      'INSERT INTO tmp_a (A) WITH TGFPAR AS (SELECT A FROM TGFPAR) SELECT A FROM TGFPAR',
      'CREATE TEMP TABLE tmp_b AS WITH TGFPAR AS (SELECT A FROM TGFPAR) SELECT A FROM TGFPAR',
    ])('returns UNKNOWN when a CTE name shadows a table: %s', (sql) => {
      expect(classifyStatement(sql).kind).toBe('UNKNOWN');
    });

    it('excludes legitimate CTE names, including nested ones', () => {
      expect(classifyStatement('WITH x AS (SELECT 1 A) SELECT * FROM x')).toEqual({
        kind: 'SELECT',
        tables: [],
      });
      expect(
        classifyStatement('SELECT * FROM (WITH x AS (SELECT A FROM TGFPAR) SELECT A FROM x) q'),
      ).toEqual({ kind: 'SELECT', tables: ['TGFPAR'] });
      expect(
        classifyStatement('INSERT INTO tmp_a (A) WITH x AS (SELECT A FROM TGFPAR) SELECT A FROM x'),
      ).toMatchObject({ kind: 'INSERT', table: 'tmp_a', sourceTables: ['TGFPAR'] });
    });
  });

  it.each([
    'WITH x AS (UPDATE tmp_b SET a = 1 RETURNING a) SELECT * FROM tmp_a',
    'WITH x AS (INSERT INTO tmp_b (a) VALUES (1) RETURNING a) SELECT * FROM tmp_a',
    'WITH x AS (UPDATE TGFPAR SET a = 1 RETURNING a) SELECT * FROM x',
    'SELECT * FROM tmp_a WHERE a IN (WITH x AS (UPDATE tmp_b SET a = 1 RETURNING a) SELECT a FROM x)',
    'INSERT INTO tmp_a (a) WITH x AS (UPDATE TGFPAR SET a = 1 RETURNING a) SELECT a FROM x',
  ])('returns UNKNOWN for a data-modifying CTE: %s', (sql) => {
    expect(classifyStatement(sql).kind).toBe('UNKNOWN');
  });
});
