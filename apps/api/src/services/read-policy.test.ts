import { describe, expect, it } from 'vitest';
import { analyzeRead } from '@dbx/sql-engine';
import { evaluatePolicy } from '@dbx/shared';
import type { Permission, PolicyRule } from '@dbx/shared';
import type { Catalog } from './metadata';
import { readTargets } from './read-policy';

const table = (name: string, columns: string[]) => ({
  name,
  columns: columns.map((c) => ({ name: c, type: 'string', pk: false })),
  foreignKeys: [],
});

const CATALOG: Catalog = {
  tables: [
    table('TGFPAR', ['CODPARC', 'NOMEPARC', 'EMAIL']),
    table('TSICID', ['CODCID', 'NOMECID']),
    table('TGFEMPTY', []),
  ],
  fetchedAt: '2026-01-01T00:00:00.000Z',
  source: 'dictionary',
};

const targets = (sql: string) => readTargets(analyzeRead(sql, { dialect: 'oracle' }), CATALOG);
const names = (sql: string) =>
  targets(sql)
    .columns.map((c) => `${c.table}.${c.name}`)
    .sort();

const DENY_EMAIL: PolicyRule = {
  id: 'r1',
  name: 'no e-mail',
  effect: 'DENY',
  subjectType: 'everyone',
  subjectId: null,
  environments: [],
  connectionIds: [],
  actions: ['QUERY.SELECT'],
  entities: [],
  columns: ['TGFPAR.EMAIL'],
  limits: {},
  overrideWhereRequired: false,
  enabled: true,
};

function decide(sql: string) {
  const t = targets(sql);
  return evaluatePolicy(
    {
      userId: 'u1',
      groupIds: [],
      action: 'QUERY.SELECT',
      environment: 'SANDBOX',
      connectionId: 'c1',
      entities: t.entities,
      columns: t.columns,
      hasWhere: false,
    },
    [DENY_EMAIL],
    new Set<Permission>(['QUERY.SELECT']),
  ).effect;
}

describe('readTargets', () => {
  it('lists every base table once, upper-cased', () => {
    expect(targets('SELECT p.CODPARC FROM TGFPAR p JOIN TGFPAR q ON 1 = 1').entities).toEqual([
      'TGFPAR',
    ]);
  });

  it('expands SELECT * from the catalog', () => {
    expect(names('SELECT * FROM TGFPAR')).toEqual([
      'TGFPAR.CODPARC',
      'TGFPAR.EMAIL',
      'TGFPAR.NOMEPARC',
    ]);
  });

  it('expands a qualified star through its alias only', () => {
    expect(names('SELECT c.* FROM TGFPAR p JOIN TSICID c ON 1 = 1')).toEqual([
      'TSICID.CODCID',
      'TSICID.NOMECID',
    ]);
  });

  it('keeps an unexpandable star as * (hit by every column DENY of its table)', () => {
    expect(names('SELECT * FROM TGFEMPTY')).toEqual(['TGFEMPTY.*']);
  });

  it('resolves aliases and attributes unqualified or unresolvable columns to every table', () => {
    expect(names('SELECT p.NOMEPARC, CODCID FROM TGFPAR p JOIN TSICID c ON 1 = 1')).toEqual([
      'TGFPAR.CODCID',
      'TGFPAR.NOMEPARC',
      'TSICID.CODCID',
    ]);
    expect(names('SELECT x.EMAIL FROM (SELECT NOMEPARC FROM TGFPAR) x')).toEqual([
      'TGFPAR.EMAIL',
      'TGFPAR.NOMEPARC',
    ]);
  });

  it('a column DENY sees the column wherever it is referenced', () => {
    expect(decide('SELECT * FROM TGFPAR')).toBe('DENY');
    expect(decide('SELECT EMAIL FROM TGFPAR')).toBe('DENY');
    expect(decide('SELECT p.email FROM TGFPAR p')).toBe('DENY');
    expect(decide("SELECT NOMEPARC FROM TGFPAR WHERE EMAIL LIKE 'a%'")).toBe('DENY');
    expect(decide('SELECT NOMEPARC FROM TGFPAR ORDER BY EMAIL')).toBe('DENY');
    expect(decide('WITH c AS (SELECT EMAIL AS E FROM TGFPAR) SELECT E FROM c')).toBe('DENY');
    expect(decide('SELECT x.* FROM (SELECT * FROM TGFPAR) x')).toBe('DENY');
    expect(decide('SELECT NOMEPARC FROM TGFPAR')).toBe('ALLOW');
    expect(decide('SELECT * FROM TSICID')).toBe('ALLOW');
  });
});
