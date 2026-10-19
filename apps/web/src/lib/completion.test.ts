import { describe, expect, it } from 'vitest';
import type { CatalogTable } from '../api/types';
import { findAliases, statementAt, suggest } from './completion';

const col = (name: string, pk = false) => ({ name, type: 'NUMBER', pk });
const tables: CatalogTable[] = [
  {
    name: 'TGFPAR',
    description: 'Parceiros',
    columns: [col('CODPARC', true), col('NOMEPARC'), col('CODCID')],
    foreignKeys: [],
  },
  {
    name: 'TGFCAB',
    columns: [col('NUNOTA', true), col('CODPARC')],
    foreignKeys: [{ column: 'CODPARC', refTable: 'TGFPAR', refColumn: 'CODPARC' }],
  },
];

describe('findAliases', () => {
  it('maps aliases and ignores reserved words', () => {
    const a = findAliases(
      'SELECT * FROM TGFPAR p JOIN TGFCAB AS c ON c.CODPARC = p.CODPARC WHERE 1=1',
      tables,
    );
    expect(a.get('p')).toBe('tgfpar');
    expect(a.get('c')).toBe('tgfcab');
    expect(findAliases('SELECT * FROM TGFPAR WHERE x = 1', tables).has('where')).toBe(false);
  });
  it('ignores unknown tables', () => {
    expect(findAliases('SELECT * FROM SEGREDOS s', tables).size).toBe(0);
  });
});

describe('suggest', () => {
  it('suggests tables after FROM', () => {
    const s = suggest('SELECT * FROM TG', 'SELECT * FROM TG', tables);
    expect(s.map((x) => x.label)).toEqual(['TGFPAR', 'TGFCAB']);
    expect(s[0]!.detail).toBe('tabela · Parceiros');
    expect(s[1]!.detail).toBe('tabela');
  });
  it('suggests columns of an alias after a dot', () => {
    const sql = 'SELECT p. FROM TGFPAR p';
    const s = suggest('SELECT p.', sql, tables);
    expect(s.map((x) => x.label)).toEqual(['CODPARC', 'NOMEPARC', 'CODCID']);
    expect(s.every((x) => x.kind === 'column')).toBe(true);
  });
  it('offers columns in scope plus keywords and functions', () => {
    const sql = 'SELECT  FROM TGFPAR';
    const s = suggest('SELECT ', sql, tables);
    const labels = s.map((x) => x.label);
    expect(labels).toContain('NOMEPARC');
    expect(labels).toContain('COUNT');
    expect(labels).toContain('WHERE');
    expect(labels).not.toContain('NUNOTA');
    expect(labels).not.toContain('UPDATE');
  });
  it('returns nothing for an unknown qualifier', () => {
    expect(suggest('SELECT x.', 'SELECT x.', tables)).toEqual([]);
  });
});

describe('statementAt', () => {
  const text = "SELECT 1 FROM DUAL;\nSELECT ';' AS x FROM TGFPAR; -- a;b\nSELECT 2";
  it('returns the statement under the cursor, ignoring ; in strings and comments', () => {
    expect(statementAt(text, 3).sql).toBe('SELECT 1 FROM DUAL');
    expect(statementAt(text, 26).sql).toBe("SELECT ';' AS x FROM TGFPAR");
    expect(statementAt(text, text.length).sql).toBe('-- a;b\nSELECT 2');
  });
  it('uses the previous statement when the cursor is after the final ;', () => {
    const t = 'SELECT 1;\nSELECT 2;\n';
    expect(statementAt(t, t.length).sql).toBe('SELECT 2');
  });
  it('handles empty text', () => {
    expect(statementAt('', 0).sql).toBe('');
  });
});
