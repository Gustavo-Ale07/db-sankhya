import { describe, expect, it } from 'vitest';
import type { SelectStatement } from './ast';
import { cleanFloat, compareValues, compileLike, orderValues, suggest } from './eval';
import { evaluateSelect } from './local/evaluate';
import { parseSql } from './parser';

describe('value helpers', () => {
  it('translates LIKE patterns, honouring ESCAPE and regex metacharacters', () => {
    expect(compileLike('abc%')('ABCdef')).toBe(true);
    expect(compileLike('a_c')('abc')).toBe(true);
    expect(compileLike('a_c')('abbc')).toBe(false);
    expect(compileLike('100!%', '!')('100%')).toBe(true);
    expect(compileLike('100!%', '!')('1000')).toBe(false);
    expect(compileLike('a.c')('abc')).toBe(false);
    expect(compileLike('(x)*')('(x)*')).toBe(true);
    expect(compileLike('%')('')).toBe(true);
    expect(compileLike('_')('')).toBe(false);
    expect(compileLike('%são%')('SÃO PAULO')).toBe(true);
    expect(compileLike('a%b%c')('axxbyyc')).toBe(true);
    expect(compileLike('a%b%c')('axxbyy')).toBe(false);
    expect(compileLike('%ab')('aab')).toBe(true);
    expect(compileLike('line1%line2')('line1\nline2')).toBe(true);
  });

  it('matches LIKE in linear time on patterns that make backtracking regexes explode', () => {
    const start = performance.now();
    const text = 'a'.repeat(5000);
    expect(compileLike(`${'%a'.repeat(40)}%b`)(text)).toBe(false);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('compares with NULL as unknown and orders NULLs first', () => {
    expect(compareValues(null, 1)).toBeNull();
    expect(compareValues('10', 9)).toBeGreaterThan(0);
    expect([3, null, 1].sort(orderValues)).toEqual([null, 1, 3]);
    expect(['item 10', 'item 2'].sort(orderValues)).toEqual(['item 2', 'item 10']);
  });

  it('cleans floating-point noise', () => {
    expect(cleanFloat(0.1 + 0.2)).toBe(0.3);
    expect(cleanFloat(1182882.290000001)).toBe(1182882.29);
    expect(cleanFloat(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('suggests close names only', () => {
    expect(suggest('pedidos', ['pedidos_venda', 'clientes'])).toBe('pedidos_venda');
    expect(suggest('zzzz', ['clientes'])).toBeUndefined();
  });
});

describe('three-valued logic', () => {
  const value = (expr: string) =>
    evaluateSelect(parseSql(`SELECT ${expr} AS v`) as SelectStatement, {}).rows[0]?.[0];

  it('propagates NULL through comparisons and boolean operators', () => {
    expect(value('NULL = NULL')).toBeNull();
    expect(value('NULL AND 1 = 0')).toBe(false);
    expect(value('NULL OR 1 = 1')).toBe(true);
    expect(value('NOT (NULL = 1)')).toBeNull();
    expect(value('1 IN (2, NULL)')).toBeNull();
    expect(value('1 NOT IN (2, NULL)')).toBeNull();
    expect(value('NULL IS NULL')).toBe(true);
  });
});
