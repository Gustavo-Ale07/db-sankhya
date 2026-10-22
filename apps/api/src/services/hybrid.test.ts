import { describe, expect, it } from 'vitest';
import { planScratchCreateAs } from './hybrid';

describe('planScratchCreateAs', () => {
  it('copies a Sankhya-only query whole and creates the table from the copy', () => {
    const plan = planScratchCreateAs(
      'CREATE TEMPORARY TABLE tmp_p AS SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC < 5',
    );
    expect(plan.parts).toHaveLength(1);
    const [part] = plan.parts;
    expect(part).toMatchObject({
      sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR WHERE CODPARC < 5',
      tables: ['TGFPAR'],
    });
    expect(part!.into).toMatch(/^tmp__hyb_[0-9a-f]{10}_1$/);
    expect(plan.statement).toMatchObject({ command: 'CREATE TABLE', target: 'tmp_p' });
    expect(plan.statement.sql).toContain(part!.into);
    expect(plan.statement.sql).not.toMatch(/TGFPAR/i);
  });

  it('splits a query that mixes tmp_ and Sankhya tables', () => {
    const plan = planScratchCreateAs(
      'CREATE TABLE tmp_j AS WITH p AS (SELECT CODPARC, NOMEPARC FROM TGFPAR) ' +
        'SELECT t.id, p.nomeparc FROM tmp_ids t JOIN p ON p.codparc = t.id',
    );
    expect(plan.parts.map((p) => p.tables)).toEqual([['TGFPAR']]);
    expect(plan.statement).toMatchObject({ command: 'CREATE TABLE', target: 'tmp_j' });
    expect(plan.statement.tables).toContain('tmp_ids');
  });

  it('refuses anything but CREATE TABLE … AS SELECT', () => {
    expect(() => planScratchCreateAs('CREATE TABLE tmp_x (a int)')).toThrow(/CREATE TABLE tmp_/);
    expect(() => planScratchCreateAs('SELECT * FROM TGFPAR')).toThrow();
    expect(() =>
      planScratchCreateAs('CREATE TABLE tmp_x AS SELECT * FROM TGFPAR; DROP TABLE tmp_a'),
    ).toThrow();
  });
});
