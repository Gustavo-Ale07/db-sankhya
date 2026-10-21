import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { analyzeRead } from './read-analyzer';

function errorOf(fn: () => unknown): { code: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (isAppError(err)) return { code: err.code, message: err.message };
    throw err;
  }
  throw new Error('expected an error');
}

describe('analyzeRead', () => {
  it('collects tables through CTE, subquery, join and CASE, excluding the CTE name', () => {
    const r = analyzeRead(`
      WITH ativos AS (SELECT CODPARC FROM TGFPAR WHERE ATIVO = 'S')
      SELECT P.NOMEPARC,
             CASE WHEN C.UF = 'SP' THEN 'local' ELSE 'fora' END AS REGIAO,
             (SELECT MAX(X.CODCID) FROM TSICID X) AS MAXCID
        FROM TGFPAR P
        JOIN TSICID C ON C.CODCID = P.CODCID
       WHERE P.CODPARC IN (SELECT CODPARC FROM ativos)`);
    expect(new Set(r.tables.map((t) => t.name))).toEqual(new Set(['TGFPAR', 'TSICID']));
    expect(r.ctes).toEqual(['ativos']);
    expect(r.tables).toContainEqual({ name: 'TGFPAR', alias: 'P' });
    expect(r.functions).toEqual(['MAX']);
    expect(r.columns).toContainEqual({ table: 'C', name: 'UF' });
  });

  it('refuses a function outside the allowlist, naming it', () => {
    const e = errorOf(() => analyzeRead('SELECT MY_PKG_FN(1) FROM TGFPAR'));
    expect(e.code).toBe('SQL_UNSUPPORTED');
    expect(e.message).toContain('MY_PKG_FN');
  });

  it.each([
    'UPDATE TGFPAR SET NOMEPARC = 1 WHERE CODPARC = 1',
    'DELETE FROM TGFPAR WHERE CODPARC = 1',
    'INSERT INTO TGFPAR (CODPARC) VALUES (1)',
    'SELECT * INTO T2 FROM TGFPAR',
    'SELECT 1 FROM TGFPAR FOR XML PATH',
    'SELECT * FROM dbo.TGFPAR',
    'SELECT 1 FROM DUAL; SELECT 2 FROM DUAL',
  ])('refuses non-plain-select %s', (sql) => {
    expect(errorOf(() => analyzeRead(sql)).code).toBe('SQL_UNSUPPORTED');
  });

  it('collects both sides of a UNION', () => {
    const r = analyzeRead('SELECT CODPARC FROM TGFPAR UNION ALL SELECT CODCID FROM TSICID');
    expect(r.tables.map((t) => t.name)).toEqual(['TGFPAR', 'TSICID']);
  });

  it('throws SQL_PARSE_ERROR for unparseable input', () => {
    expect(errorOf(() => analyzeRead('SELEC FROM WHERE')).code).toBe('SQL_PARSE_ERROR');
  });

  it('collects columns from WHERE, GROUP BY, HAVING and ORDER BY', () => {
    const r = analyzeRead(
      'SELECT UF, COUNT(*) N FROM TSICID WHERE ATIVO = 1 GROUP BY UF HAVING SUM(POP) > 10 ORDER BY NOMECID',
    );
    expect(r.columns.map((c) => c.name)).toEqual(['UF', 'ATIVO', 'UF', 'POP', 'NOMECID']);
    expect(r.star).toEqual([{ inAggregate: true }]);
    expect(r.functions.sort()).toEqual(['COUNT', 'SUM']);
  });

  it('marks only the star that is the direct argument of COUNT as inAggregate', () => {
    expect(analyzeRead('SELECT COUNT(*) FROM TGFPAR').star).toEqual([{ inAggregate: true }]);
    expect(analyzeRead('SELECT *, COUNT(*) OVER () N FROM TGFPAR').star).toEqual([
      {},
      { inAggregate: true },
    ]);
    // An aggregate over a column still references the column.
    const r = analyzeRead('SELECT COUNT(EMAIL), MAX(NOMEPARC) FROM TGFPAR');
    expect(r.star).toEqual([]);
    expect(r.columns).toEqual([{ name: 'EMAIL' }, { name: 'NOMEPARC' }]);
    // A star nested in a subquery inside an aggregate is a plain star.
    expect(analyzeRead('SELECT COUNT(*) FROM (SELECT * FROM TGFPAR) X').star).toEqual([
      { inAggregate: true },
      {},
    ]);
  });

  it('records stars, quoted and bracketed identifiers', () => {
    const r = analyzeRead('SELECT P.*, [NOME PARC], "INTO" FROM TGFPAR P');
    expect(r.star).toEqual([{ table: 'P' }]);
    expect(r.columns).toEqual([{ name: 'NOME PARC' }, { name: 'INTO' }]);
  });

  it('accepts common functions, windows, TOP and paging', () => {
    const r = analyzeRead(
      `
      SELECT TOP 10 ROW_NUMBER() OVER (PARTITION BY UF ORDER BY NOMECID DESC) RN,
             CONVERT(VARCHAR(10), DTALTER), DATEADD(day, 1, DTALTER), CAST(CODCID AS INT),
             COALESCE(UF, 'XX'), GETDATE()
        FROM TSICID WITH (NOLOCK)
       WHERE NOMECID LIKE 'S%' AND CODCID BETWEEN 1 AND 9 AND UF IS NOT NULL`,
      { dialect: 'mssql' },
    );
    expect(r.functions.sort()).toEqual(
      ['CAST', 'COALESCE', 'CONVERT', 'DATEADD', 'GETDATE', 'ROW_NUMBER'].sort(),
    );
    expect(r.columns.map((c) => c.name)).not.toContain('day');
  });

  it('refuses table hints other than NOLOCK', () => {
    // Either refusal is fine: the grammar may not even accept the hint.
    expect(['SQL_UNSUPPORTED', 'SQL_PARSE_ERROR']).toContain(
      errorOf(() => analyzeRead('SELECT 1 FROM T WITH (TABLOCKX)')).code,
    );
  });
  describe('CTE scoping', () => {
    it.each([
      // The CTE body reads the real table it shadows.
      'WITH TGFPAR AS (SELECT * FROM TGFPAR) SELECT * FROM TGFPAR',
      // Recursive-looking self reference.
      'WITH x AS (SELECT 1 A FROM DUAL UNION ALL SELECT A FROM x) SELECT A FROM x',
      // An earlier CTE body reads the real table a later CTE is named after.
      'WITH a AS (SELECT CODPARC FROM TGFPAR), TGFPAR AS (SELECT 1 A FROM DUAL) SELECT * FROM a',
      // A CTE in a derived table hides the real table in an unrelated subquery.
      'SELECT q.A FROM (WITH TGFPAR AS (SELECT 1 A FROM DUAL) SELECT A FROM TGFPAR) q WHERE q.A IN (SELECT SENHA FROM TGFPAR)',
      'SELECT q.A FROM (WITH TGFPAR AS (SELECT 1 A FROM DUAL) SELECT A FROM TGFPAR) q JOIN TGFPAR P ON P.CODPARC = q.A',
      // ... or on the other side of a UNION.
      'SELECT A FROM (WITH TGFPAR AS (SELECT 1 A FROM DUAL) SELECT A FROM TGFPAR) q UNION SELECT SENHA FROM TGFPAR',
      // Duplicate CTE names (case-insensitive).
      'WITH x AS (SELECT 1 A FROM DUAL), X AS (SELECT 2 A FROM DUAL) SELECT A FROM x',
      // WITH after a set operator has ambiguous scope.
      'SELECT A FROM TSICID UNION WITH x AS (SELECT 1 A FROM DUAL) SELECT A FROM x',
    ])('refuses CTE names that shadow or collide: %s', (sql) => {
      expect(errorOf(() => analyzeRead(sql)).code).toBe('SQL_UNSUPPORTED');
    });

    it('excludes a legitimate CTE from tables', () => {
      const r = analyzeRead('WITH x AS (SELECT 1 A FROM DUAL) SELECT * FROM x');
      expect(r.ctes).toEqual(['x']);
      expect(r.tables).toEqual([]);
    });

    it('lets later CTEs and both UNION sides of the main query see earlier CTEs', () => {
      const r = analyzeRead(
        'WITH a AS (SELECT CODPARC FROM TGFPAR), b AS (SELECT CODPARC FROM a) SELECT CODPARC FROM b UNION SELECT CODPARC FROM a',
      );
      expect(r.ctes).toEqual(['a', 'b']);
      expect(r.tables).toEqual([{ name: 'TGFPAR' }]);
    });
  });

  describe('keyword first argument of CONVERT / DATEADD / DATEDIFF', () => {
    it.each([
      'SELECT DATEADD(SENHA, 1, DTNEG) FROM TGFPAR',
      'SELECT DATEDIFF(SENHA, DTNEG, DTNEG) FROM TGFPAR',
      'SELECT CONVERT(EMAIL, 1) FROM TGFPAR',
      'SELECT CONVERT(EMAIL(10), DTNEG) FROM TGFPAR',
      'SELECT DATEADD(DAY(1), 1, DTNEG) FROM TGFPAR',
      'SELECT CONVERT(NVARCHAR(MAX), DTNEG) FROM TGFPAR',
      'SELECT DATEADD("day", 1, DTNEG) FROM TGFPAR',
      'SELECT CONVERT(1, DTNEG) FROM TGFPAR',
    ])('refuses a first argument outside the allowlist: %s', (sql) => {
      expect(errorOf(() => analyzeRead(sql, { dialect: 'mssql' })).code).toBe('SQL_UNSUPPORTED');
    });

    it('accepts date parts and type names, collecting the other arguments', () => {
      const r = analyzeRead(
        'SELECT DATEADD(day, 1, DTNEG), DATEDIFF(yyyy, DTNEG, DTFATUR), CONVERT(VARCHAR(10), DTNEG, 103), CONVERT(int, CODPARC), CONVERT(DECIMAL(10, 2), VLRNOTA) FROM TGFCAB',
        { dialect: 'mssql' },
      );
      expect(r.columns.map((c) => c.name)).toEqual([
        'DTNEG',
        'DTNEG',
        'DTFATUR',
        'DTNEG',
        'CODPARC',
        'VLRNOTA',
      ]);
    });
  });

  it.each([
    'SELECT P.[1] FROM TSIUSU PIVOT (MAX(SENHA) FOR CODUSU IN ([1])) P',
    'SELECT U.V FROM TSIUSU UNPIVOT (V FOR K IN (SENHA, EMAIL)) U',
  ])('refuses PIVOT / UNPIVOT: %s', (sql) => {
    expect(errorOf(() => analyzeRead(sql)).code).toBe('SQL_UNSUPPORTED');
  });

  it.each([
    'WITH x AS (UPDATE TGFPAR SET A = 1) SELECT * FROM x',
    'WITH x AS (DELETE FROM TGFPAR) SELECT * FROM x',
    'WITH x AS (INSERT INTO TGFPAR (A) VALUES (1)) SELECT * FROM x',
  ])('refuses a data-modifying CTE: %s', (sql) => {
    expect(['SQL_UNSUPPORTED', 'SQL_PARSE_ERROR']).toContain(errorOf(() => analyzeRead(sql)).code);
  });

  describe('CONVERT by dialect', () => {
    it.each([
      'SELECT CONVERT(VARCHAR(10), DTNEG, 103) FROM TGFCAB',
      "SELECT CONVERT(MONEY, 'US7ASCII') FROM AD_X",
      "SELECT CONVERT(EMAIL, 'US7ASCII') FROM TGFPAR",
    ])('refuses a bare identifier or type first argument without a dialect: %s', (sql) => {
      expect(errorOf(() => analyzeRead(sql)).code).toBe('SQL_UNSUPPORTED');
    });

    it('collects a qualified first argument without a dialect', () => {
      const r = analyzeRead("SELECT CONVERT(P.EMAIL, 'US7ASCII') FROM TGFPAR P");
      expect(r.columns).toEqual([{ table: 'P', name: 'EMAIL' }]);
    });

    it('oracle: every CONVERT argument is an ordinary expression', () => {
      const r = analyzeRead(
        "SELECT CONVERT(MONEY, 'US7ASCII'), CONVERT(EMAIL, 'WE8ISO8859P1') FROM AD_X",
        {
          dialect: 'oracle',
        },
      );
      expect(r.columns.map((c) => c.name)).toEqual(['MONEY', 'EMAIL']);
    });

    it('mssql: the type allowlist applies', () => {
      const r = analyzeRead('SELECT CONVERT(VARCHAR(10), DTNEG, 103) FROM TGFCAB', {
        dialect: 'mssql',
      });
      expect(r.columns.map((c) => c.name)).toEqual(['DTNEG']);
      expect(
        errorOf(() => analyzeRead('SELECT CONVERT(EMAIL, 1) FROM TGFPAR', { dialect: 'mssql' }))
          .code,
      ).toBe('SQL_UNSUPPORTED');
    });

    it('DATEADD keeps the date-part allowlist in every dialect', () => {
      for (const dialect of [undefined, 'oracle', 'mssql'] as const) {
        const opts = dialect ? { dialect } : undefined;
        expect(analyzeRead('SELECT DATEADD(day, 1, DTNEG) FROM TGFCAB', opts).columns).toEqual([
          { name: 'DTNEG' },
        ]);
        expect(
          errorOf(() => analyzeRead('SELECT DATEADD(SENHA, 1, DTNEG) FROM TGFCAB', opts)).code,
        ).toBe('SQL_UNSUPPORTED');
      }
    });
  });

  describe('orderBy (outer query)', () => {
    it.each([
      ['SELECT CODPARC FROM TGFPAR ORDER BY CODPARC', true],
      ['SELECT CODPARC FROM TGFPAR UNION SELECT CODCID FROM TSICID ORDER BY 1', true],
      ['WITH x AS (SELECT CODPARC FROM TGFPAR) SELECT CODPARC FROM x ORDER BY CODPARC', true],
      ['SELECT CODPARC FROM TGFPAR', false],
      ['SELECT CODPARC FROM (SELECT TOP 5 CODPARC FROM TGFPAR ORDER BY CODPARC) X', false],
      ['SELECT CODPARC, ROW_NUMBER() OVER (ORDER BY CODPARC) AS N FROM TGFPAR', false],
      ["SELECT 'ORDER BY' AS T FROM TGFPAR", false],
    ])('%s -> %s', (sql, expected) => {
      expect(analyzeRead(sql).orderBy).toBe(expected);
    });
  });

  describe('joins whose columns are implicit', () => {
    it.each(
      (['oracle', 'mssql'] as const).flatMap((dialect) =>
        [
          'SELECT CODPARC FROM TGFPAR NATURAL JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR NATURAL INNER JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR natural LEFT JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR LEFT JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR INNER JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR JOIN TGFCAB',
          'SELECT CODPARC FROM TGFPAR Natural',
          'SELECT X.CODPARC FROM (SELECT CODPARC FROM TGFPAR) NATURAL JOIN TGFCAB X',
        ].map((sql) => [dialect, sql] as const),
      ),
    )('%s refuses %s', (dialect, sql) => {
      expect(errorOf(() => analyzeRead(sql, { dialect })).code).toBe('SQL_UNSUPPORTED');
    });

    it.each(['oracle', 'mssql'] as const)(
      'still accepts CROSS JOIN and ON joins on %s',
      (dialect) => {
        expect(
          analyzeRead('SELECT P.CODPARC FROM TGFPAR P CROSS JOIN TSICID C', { dialect }).tables,
        ).toHaveLength(2);
        expect(
          analyzeRead('SELECT P.CODPARC FROM TGFPAR P LEFT JOIN TSICID C ON C.CODCID = P.CODCID', {
            dialect,
          }).tables,
        ).toHaveLength(2);
      },
    );
  });

  describe('rowCapSafe (outer select list survives SELECT * FROM (...))', () => {
    it.each([
      ['SELECT CODPARC FROM TGFPAR', true],
      ['SELECT * FROM TGFPAR', true],
      ['SELECT P.CODPARC, C.NOMECID FROM TGFPAR P JOIN TSICID C ON C.CODCID = P.CODCID', true],
      ['SELECT COUNT(*) AS TOTAL FROM TGFPAR', true],
      ['SELECT CODPARC FROM TGFPAR UNION SELECT CODCID FROM TSICID', true],
      ['SELECT COUNT(*) FROM TGFPAR', false],
      ['SELECT CODPARC + 1 FROM TGFPAR', false],
      ["SELECT 'x' FROM TGFPAR", false],
      ['SELECT P.* FROM TGFPAR P', false],
      ['SELECT P.*, C.* FROM TGFPAR P JOIN TSICID C ON C.CODCID = P.CODCID', false],
      ['SELECT * FROM TGFPAR P JOIN TSICID C ON C.CODCID = P.CODCID', false],
      ['SELECT * FROM TGFPAR, TSICID', false],
      ['SELECT *, CODPARC FROM TGFPAR', false],
      ['SELECT P.CODCID, C.CODCID FROM TGFPAR P JOIN TSICID C ON C.CODCID = P.CODCID', false],
      ['SELECT CODPARC AS X, NOMEPARC AS x FROM TGFPAR', false],
      ['SELECT CODPARC FROM TGFPAR UNION SELECT COUNT(*) FROM TSICID', false],
    ])('%s -> %s', (sql, expected) => {
      expect(analyzeRead(sql).rowCapSafe).toBe(expected);
    });
  });

  describe('oracle quoted table identifiers', () => {
    it('refuses a quoted table name that is not upper case on oracle', () => {
      const e = errorOf(() => analyzeRead('SELECT CODPARC FROM "tgfpar"', { dialect: 'oracle' }));
      expect(e.code).toBe('SQL_UNSUPPORTED');
      expect(e.message).toContain('tgfpar');
    });

    it('refuses a quoted CTE name that is not upper case on oracle (it would not hide TGFPAR)', () => {
      const sql =
        'WITH "tgfpar" AS (SELECT 1 A FROM DUAL) SELECT P.* FROM TGFPAR P CROSS JOIN "tgfpar" Q';
      const e = errorOf(() => analyzeRead(sql, { dialect: 'oracle' }));
      expect(e.code).toBe('SQL_UNSUPPORTED');
      expect(e.message).toContain('tgfpar');
    });

    it('accepts upper-case quoted and unquoted lower-case table names on oracle', () => {
      expect(analyzeRead('SELECT CODPARC FROM "TGFPAR"', { dialect: 'oracle' }).tables).toEqual([
        { name: 'TGFPAR' },
      ]);
      expect(analyzeRead('SELECT codparc FROM tgfpar', { dialect: 'oracle' }).tables).toEqual([
        { name: 'tgfpar' },
      ]);
    });

    it('leaves mssql bracketed names alone (case-insensitive collation)', () => {
      expect(analyzeRead('SELECT CODPARC FROM [tgfpar]', { dialect: 'mssql' }).tables).toEqual([
        { name: 'tgfpar' },
      ]);
    });
  });
});
