import { describe, expect, it } from 'vitest';
import { splitHybrid } from './hybrid';

const scratch = (t: string) => /^tmp_/i.test(t);

describe('splitHybrid', () => {
  it('takes a CTE that reads only Sankhya as a part, keeping its text', () => {
    const sql =
      'WITH p AS (SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC < 10) ' +
      'SELECT t.id, p.nomeparc FROM tmp_ids t JOIN p ON p.codparc = t.id';
    const split = splitHybrid(sql, scratch);
    expect(split.parts.map((p) => p.sql)).toEqual([
      'SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC < 10',
    ]);
    expect(split.parts[0]!.tables).toEqual(['TGFPAR']);
    expect(split.rewrite(['tmp__h_1'])).toBe(
      'WITH p AS (SELECT * FROM tmp__h_1) SELECT t.id, p.nomeparc FROM tmp_ids t JOIN p ON p.codparc = t.id',
    );
  });

  it('takes derived tables and IN subqueries, and nothing that reads a scratch table', () => {
    const sql =
      "SELECT * FROM tmp_a a JOIN (SELECT CODPARC FROM TGFPAR WHERE ATIVO = 'S') p ON p.codparc = a.id " +
      'WHERE a.id IN (SELECT CODCID FROM TSICID WHERE UF = 1) AND a.id IN (SELECT id FROM tmp_b)';
    const split = splitHybrid(sql, scratch);
    expect(split.parts.map((p) => p.tables)).toEqual([['TGFPAR'], ['TSICID']]);
    const out = split.rewrite(['tmp__h_1', 'tmp__h_2']);
    expect(out).toContain('JOIN (SELECT * FROM tmp__h_1) p');
    expect(out).toContain('IN (SELECT * FROM tmp__h_2)');
    expect(out).toContain('IN (SELECT id FROM tmp_b)');
  });

  it('takes the outermost Sankhya subquery only, and runs identical parts once', () => {
    const sql =
      'SELECT * FROM tmp_a WHERE id IN (SELECT CODPARC FROM TGFPAR WHERE CODCID IN (SELECT CODCID FROM TSICID)) ' +
      'OR id IN (SELECT CODPARC FROM TGFPAR WHERE CODCID IN (SELECT CODCID FROM TSICID))';
    const split = splitHybrid(sql, scratch);
    expect(split.parts).toHaveLength(1);
    expect([...split.parts[0]!.tables].sort()).toEqual(['TGFPAR', 'TSICID']);
    expect(split.rewrite(['tmp__h_1'])).toBe(
      'SELECT * FROM tmp_a WHERE id IN (SELECT * FROM tmp__h_1) OR id IN (SELECT * FROM tmp__h_1)',
    );
  });

  it('leaves a direct Sankhya table reference alone (the scratch guard then refuses it)', () => {
    const split = splitHybrid('SELECT * FROM tmp_a a JOIN TGFPAR p ON p.CODPARC = a.id', scratch);
    expect(split.parts).toEqual([]);
  });

  it('ignores parentheses inside strings and quoted names', () => {
    const sql = 'SELECT \'(SELECT 1 FROM TGFPAR)\' AS x, "(" FROM tmp_a';
    expect(splitHybrid(sql, scratch).parts).toEqual([]);
  });

  it('stops early past maxParts or maxGroups', () => {
    const sql =
      'SELECT * FROM tmp_a WHERE id IN (SELECT A FROM T1) AND id IN (SELECT B FROM T2) ' +
      'AND id IN (SELECT C FROM T3)';
    expect(splitHybrid(sql, scratch, { maxParts: 2 })).toMatchObject({ parts: [], overflow: true });
    expect(splitHybrid(sql, scratch, { maxGroups: 2 })).toMatchObject({
      parts: [],
      overflow: true,
    });
    const ok = splitHybrid(sql, scratch, { maxParts: 3, maxGroups: 3 });
    expect(ok.overflow).toBe(false);
    expect(ok.parts).toHaveLength(3);
  });
});
