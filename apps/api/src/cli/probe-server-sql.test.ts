import { describe, expect, it } from 'vitest';
import { assertSelectOnly } from './probe-server-sql';

describe('assertSelectOnly (read-only guard)', () => {
  it('accepts a single SELECT', () => {
    expect(() => assertSelectOnly('SELECT 1 FROM DUAL')).not.toThrow();
    expect(() => assertSelectOnly('  select COUNT(*) as n from AD_MANIPULADADOS  ')).not.toThrow();
  });

  it('accepts a leading WITH (common table expression)', () => {
    expect(() =>
      assertSelectOnly('WITH t AS (SELECT 1 x FROM DUAL) SELECT x FROM t'),
    ).not.toThrow();
  });

  it('tolerates a single trailing semicolon', () => {
    expect(() => assertSelectOnly('SELECT 1 FROM DUAL;')).not.toThrow();
    expect(() => assertSelectOnly('SELECT 1 FROM DUAL;  ')).not.toThrow();
  });

  it('refuses a second statement smuggled after a semicolon', () => {
    expect(() => assertSelectOnly('SELECT 1 FROM DUAL; DROP TABLE AD_MANIPULADADOS')).toThrow();
    expect(() => assertSelectOnly('SELECT 1; DELETE FROM AD_MANIPULADADOS')).toThrow();
  });

  it('refuses anything that is not a SELECT/WITH', () => {
    for (const sql of [
      'DELETE FROM AD_MANIPULADADOS',
      'UPDATE AD_MANIPULADADOS SET TEXTO = null',
      'INSERT INTO AD_MANIPULADADOS (TEXTO) VALUES (1)',
      'DROP TABLE AD_MANIPULADADOS',
      'BEGIN NULL; END;',
      'CREATE TABLE x (a int)',
    ]) {
      expect(() => assertSelectOnly(sql), sql).toThrow();
    }
  });
});
