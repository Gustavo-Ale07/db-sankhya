import { describe, expect, it } from 'vitest';
import { analyzeRead } from '@dbx/sql-engine';
import { compileDenyChecker, evaluatePolicy } from '@dbx/shared';
import type { DenyChecker, Environment, Permission, PolicyRule } from '@dbx/shared';
import type { AuthState } from '../context';
import type { Catalog, CatalogTable } from './metadata';
import type { PolicyService } from './policy';
import { POLICY_FILTER_FAILED, readTargets, visibleCatalog } from './read-policy';

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

  it('does not expand COUNT(*), which reads no column value', () => {
    expect(names('SELECT COUNT(*) FROM TGFPAR')).toEqual([]);
    expect(decide('SELECT COUNT(*) FROM TGFPAR')).toBe('ALLOW');
    expect(decide('SELECT * FROM TGFPAR')).toBe('DENY');
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
    expect(decide('SELECT COUNT(EMAIL) FROM TGFPAR')).toBe('DENY');
    expect(decide('SELECT COUNT(*) FROM (SELECT * FROM TGFPAR) x')).toBe('DENY');
    expect(decide('SELECT * FROM TSICID')).toBe('ALLOW');
  });
});

describe('visibleCatalog', () => {
  const PERMS = new Set<Permission>(['QUERY.SELECT']);
  const CONTEXT = { groupIds: ['g1'], environment: 'SANDBOX' as Environment, connectionId: 'c1' };
  const auth = {
    user: { id: 'u1' },
    grants: { permissions: PERMS },
  } as unknown as AuthState;
  /** A policy service over `rules`, counting the checks it answers. */
  const fake = (rules: PolicyRule[]) => {
    const stats = { checks: 0 };
    const policies = {
      denyChecker: (ctx: Parameters<typeof compileDenyChecker>[0], perms: Set<Permission>) => {
        const inner = compileDenyChecker(ctx, rules, perms);
        if (!inner) return Promise.resolve(null);
        const counted: DenyChecker = {
          denyRules: inner.denyRules,
          denied: (e, c) => {
            stats.checks++;
            return inner.denied(e, c);
          },
        };
        return Promise.resolve(counted);
      },
    } as unknown as PolicyService;
    return { policies, stats };
  };
  const run = (rules: PolicyRule[], catalog: Catalog) =>
    visibleCatalog({ policies: fake(rules).policies, auth, ...CONTEXT }, catalog);

  /** The pre-compilation algorithm: one full `evaluatePolicy` per table and per column. */
  const reference = (rules: PolicyRule[], catalog: Catalog) => {
    const allowed = (entity: string, columns: Array<{ table: string; name: string }>) =>
      evaluatePolicy(
        {
          userId: 'u1',
          action: 'QUERY.SELECT',
          ...CONTEXT,
          entities: [entity],
          columns,
          hasWhere: false,
        },
        rules,
        PERMS,
      ).effect === 'ALLOW';
    const out: Record<string, string[]> = {};
    for (const t of catalog.tables) {
      const e = t.name.toUpperCase();
      if (!allowed(e, [])) continue;
      out[t.name] = t.columns
        .filter((c) => allowed(e, [{ table: e, name: c.name }]))
        .map((c) => c.name);
    }
    return out;
  };

  const withFks: Catalog = {
    ...CATALOG,
    tables: [
      {
        ...table('TGFPAR', ['CODPARC', 'NOMEPARC', 'EMAIL', 'CODCID']),
        foreignKeys: [
          { column: 'CODCID', refTable: 'TSICID', refColumn: 'CODCID' },
          { column: 'EMAIL', refTable: 'TGFEMPTY', refColumn: 'X' },
        ],
      },
      table('TSICID', ['CODCID', 'NOMECID']),
      table('TGFEMPTY', []),
    ],
  };
  const shape = (c: Catalog) =>
    Object.fromEntries(c.tables.map((t) => [t.name, t.columns.map((x) => x.name)]));

  it('returns the very same catalog, with no per-table check, when no DENY applies', async () => {
    const { policies, stats } = fake([
      { ...DENY_EMAIL, subjectType: 'user', subjectId: 'someone-else' },
      { ...DENY_EMAIL, environments: ['PRODUCTION'] },
      { ...DENY_EMAIL, connectionIds: ['c2'] },
      { ...DENY_EMAIL, subjectType: 'group', subjectId: 'g2' },
    ]);
    const out = await visibleCatalog({ policies, auth, ...CONTEXT }, withFks);
    expect(out).toBe(withFks);
    expect(stats.checks).toBe(0);
  });

  it('drops denied columns and the foreign keys that would name them', async () => {
    const out = await run([DENY_EMAIL], withFks);
    expect(shape(out)).toEqual({
      TGFPAR: ['CODPARC', 'NOMEPARC', 'CODCID'],
      TSICID: ['CODCID', 'NOMECID'],
      TGFEMPTY: [],
    });
    expect(out.tables[0]!.foreignKeys).toEqual([
      { column: 'CODCID', refTable: 'TSICID', refColumn: 'CODCID' },
    ]);
  });

  it('drops denied tables and foreign keys into them', async () => {
    const out = await run([{ ...DENY_EMAIL, columns: [], entities: ['TSICID'] }], withFks);
    expect(Object.keys(shape(out))).toEqual(['TGFPAR', 'TGFEMPTY']);
    expect(out.tables[0]!.foreignKeys).toEqual([
      { column: 'EMAIL', refTable: 'TGFEMPTY', refColumn: 'X' },
    ]);
  });

  it('hides a malformed name even with no rule, as the read path denies it', async () => {
    const odd: Catalog = {
      ...CATALOG,
      tables: [table('BAD NAME', ['A']), table('T', ['OK', 'X"Y'])],
    };
    expect(shape(await run([], odd))).toEqual({ T: ['OK'] });
  });

  it('decides exactly like per-request evaluatePolicy (table-driven and randomized)', async () => {
    const base = DENY_EMAIL;
    const fixed: PolicyRule[][] = [
      [],
      [base],
      [{ ...base, columns: ['EMAIL'] }],
      [{ ...base, columns: ['*'] }],
      [{ ...base, columns: [], entities: ['TGF*'] }],
      [{ ...base, columns: [], entities: ['X.TSICID'] }],
      [{ ...base, columns: ['T*.NOME*', 'CODCID'] }],
      [{ ...base, subjectType: 'group', subjectId: 'g1', columns: [], entities: ['TSICID'] }],
      [{ ...base, effect: 'ALLOW', columns: [], entities: ['TSICID'], limits: { maxReadRows: 1 } }],
      [{ ...base, columns: [], entities: ['*'] }],
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const some = <T>(xs: readonly T[]) => xs.filter(() => rnd() < 0.3);
    const random = (): PolicyRule[] =>
      Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => ({
        ...base,
        id: `r${i}`,
        effect: rnd() < 0.75 ? 'DENY' : 'ALLOW',
        subjectType: rnd() < 0.6 ? 'everyone' : 'group',
        subjectId: rnd() < 0.5 ? 'g1' : 'g2',
        environments: some(['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'] as const),
        connectionIds: some(['c1', 'c2']),
        entities: rnd() < 0.5 ? [] : some(['TGFPAR', 'TGF*', 'TSICID', 'SYS.*']),
        columns: rnd() < 0.4 ? [] : some(['TGFPAR.EMAIL', 'EMAIL', 'CODCID', 'NOME*', '*']),
      }));
    const catalog: Catalog = {
      ...CATALOG,
      tables: [
        table('TGFPAR', ['CODPARC', 'NOMEPARC', 'EMAIL', 'CODCID']),
        table('TSICID', ['CODCID', 'NOMECID']),
        table('TGFPRO', ['CODPROD', 'DESCRPROD']),
        table('TGFEMPTY', []),
        table('AD_X', ['NOMEX', 'EMAIL']),
      ],
    };
    const sets = [...fixed, ...Array.from({ length: 200 }, random)];
    let hidden = 0;
    for (const rules of sets) {
      const out = await run(rules, catalog);
      const expected = reference(rules, catalog);
      expect(shape(out), JSON.stringify(rules)).toEqual(expected);
      if (Object.keys(expected).length < catalog.tables.length) hidden++;
    }
    // The sets exercise both outcomes.
    expect(hidden).toBeGreaterThan(20);
    expect(hidden).toBeLessThan(sets.length - 20);
  });

  it('filters 5,000 tables quickly: no check with 50 non-matching rules, few with a column DENY', async () => {
    const columns = Array.from({ length: 30 }, (_, i) => `COL${i}`);
    const big: Catalog = {
      ...CATALOG,
      tables: Array.from({ length: 5000 }, (_, i) => table(`T${i}`, [...columns, 'CODUSU'])),
    };
    const nonMatching: PolicyRule[] = Array.from({ length: 50 }, (_, i) => ({
      ...DENY_EMAIL,
      id: `n${i}`,
      columns: ['CODUSU'],
      subjectType: 'user',
      subjectId: `other-${i}`,
    }));
    const quiet = fake(nonMatching);
    let started = performance.now();
    expect(await visibleCatalog({ policies: quiet.policies, auth, ...CONTEXT }, big)).toBe(big);
    expect(quiet.stats.checks).toBe(0);
    expect(performance.now() - started).toBeLessThan(2000);

    const loud = fake([...nonMatching, { ...DENY_EMAIL, columns: ['CODUSU'] }]);
    started = performance.now();
    const out = await visibleCatalog({ policies: loud.policies, auth, ...CONTEXT }, big);
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(out.tables).toHaveLength(5000);
    expect(out.tables.every((t: CatalogTable) => t.columns.length === 30)).toBe(true);
    // Bisection: about 2 log2(31) checks per table, not one per column.
    expect(loud.stats.checks).toBeLessThan(5000 * 15);
  });

  it('serves no table, marked degraded, when the rules cannot be compiled or a check throws', async () => {
    const invalid = await run([{ ...DENY_EMAIL, actions: [] }], withFks);
    expect(invalid.tables).toEqual([]);
    expect(invalid.degraded).toEqual([POLICY_FILTER_FAILED]);

    const policies = {
      denyChecker: () => Promise.reject(new Error('boom')),
    } as unknown as PolicyService;
    const errors: unknown[] = [];
    const out = await visibleCatalog({ policies, auth, ...CONTEXT }, withFks, (e) =>
      errors.push(e),
    );
    expect(out.tables).toEqual([]);
    expect(out.fetchedAt).toBe(withFks.fetchedAt);
    expect(out.degraded).toEqual([POLICY_FILTER_FAILED]);
    expect(errors).toHaveLength(1);

    // A throwing reporter does not turn the fail-closed answer into an error.
    const quiet = await visibleCatalog({ policies, auth, ...CONTEXT }, withFks, () => {
      throw new Error('logger down');
    });
    expect(quiet.tables).toEqual([]);
  });
});
