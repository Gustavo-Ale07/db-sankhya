import { describe, expect, it } from 'vitest';
import type { CatalogTable } from '../api/types';
import { groupByPrefix, tablePrefix } from './schemaGroups';

const table = (name: string): CatalogTable => ({ name, columns: [], foreignKeys: [] });

describe('tablePrefix', () => {
  it('uses three letters for dictionary tables and the underscore prefix for custom ones', () => {
    expect(tablePrefix('TGFPAR')).toBe('TGF');
    expect(tablePrefix('tsicid')).toBe('TSI');
    expect(tablePrefix('AD_CLIENTE')).toBe('AD_');
    expect(tablePrefix('DUAL')).toBe('DUA');
    expect(tablePrefix('ABC')).toBe('ABC');
  });
});

describe('groupByPrefix', () => {
  it('groups, and sorts groups and tables by name', () => {
    const groups = groupByPrefix([
      table('TSICID'),
      table('TGFPAR'),
      table('AD_X'),
      table('TGFCAB'),
    ]);
    expect(groups.map((g) => g.prefix)).toEqual(['AD_', 'TGF', 'TSI']);
    expect(groups[1]!.tables.map((t) => t.name)).toEqual(['TGFCAB', 'TGFPAR']);
  });
  it('returns no group for no tables', () => {
    expect(groupByPrefix([])).toEqual([]);
  });
});
