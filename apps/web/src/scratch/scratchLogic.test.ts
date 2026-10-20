import { describe, expect, it } from 'vitest';
import { describeMaterialize, isScratchTableName, sourceToSql } from './scratchLogic';

describe('isScratchTableName', () => {
  it('accepts lowercase tmp_ names only', () => {
    expect(isScratchTableName('tmp_parceiros')).toBe(true);
    expect(isScratchTableName('tmp_')).toBe(false);
    expect(isScratchTableName('TMP_X')).toBe(false);
    expect(isScratchTableName('parceiros')).toBe(false);
    expect(isScratchTableName('tmp_a-b')).toBe(false);
    expect(isScratchTableName(`tmp_${'a'.repeat(60)}`)).toBe(false);
  });
});

describe('sourceToSql', () => {
  it('turns a bare table into a SELECT and strips the trailing semicolon', () => {
    expect(sourceToSql(' TGFPAR ')).toBe('SELECT * FROM TGFPAR');
    expect(sourceToSql('SELECT 1 FROM TGFPAR;')).toBe('SELECT 1 FROM TGFPAR');
    expect(sourceToSql('  ')).toBeNull();
  });
});

describe('describeMaterialize', () => {
  it('reports the row count and the truncation', () => {
    expect(describeMaterialize({ table: 'tmp_a', rows: 1, truncated: false })).toBe(
      'Tabela tmp_a criada com 1 linha.',
    );
    expect(describeMaterialize({ table: 'tmp_a', rows: 5, truncated: true })).toContain('truncado');
  });
});
