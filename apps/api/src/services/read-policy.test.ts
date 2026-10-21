import { describe, expect, it, vi } from 'vitest';
import { analyzeRead } from '@dbx/sql-engine';
import { compileDenyChecker, evaluatePolicy } from '@dbx/shared';
import type { DenyChecker, Environment, Permission, PolicyRule } from '@dbx/shared';
import type { AuthState } from '../context';
import type { Catalog, CatalogTable } from './metadata';
import type { PolicyService } from './policy';
import {
  POLICY_FILTER_FAILED,
  findVisibleTable,
  memoizedCatalogs,
  readTargets,
  visibleCatalog,
} from './read-policy';

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

  it('expands SELECT * from the catalog and keeps the * for columns the dictionary lacks', () => {
    expect(names('SELECT * FROM TGFPAR')).toEqual([
      'TGFPAR.*',
      'TGFPAR.CODPARC',
      'TGFPAR.EMAIL',
      'TGFPAR.NOMEPARC',
    ]);
  });

  it('expands a qualified star through its alias only', () => {
    expect(names('SELECT c.* FROM TGFPAR p JOIN TSICID c ON 1 = 1')).toEqual([
      'TSICID.*',
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
  /**
   * A policy service over `rules`, counting the table and column decisions it answers. With a
   * `version`, its checkers carry it (as `PolicyService.denyChecker` does) and results are memoized.
   */
  const fake = (rules: PolicyRule[], version?: string) => {
    const stats = { tables: 0, columns: 0 };
    const state = { rules, version };
    const policies = {
      denyChecker: (ctx: Parameters<typeof compileDenyChecker>[0], perms: Set<Permission>) => {
        const inner = compileDenyChecker(ctx, state.rules, perms);
        if (!inner) return Promise.resolve(null);
        const counted: DenyChecker = {
          denyRules: inner.denyRules,
          ...(state.version === undefined ? {} : { policyVersion: state.version }),
          denied: (e, c) => inner.denied(e, c),
          forTable: (t) => {
            stats.tables++;
            const verdict = inner.forTable(t);
            return (
              verdict && {
                patterns: verdict.patterns,
                columnDenied: (c) => {
                  stats.columns++;
                  return verdict.columnDenied(c);
                },
              }
            );
          },
        };
        return Promise.resolve(counted);
      },
    } as unknown as PolicyService;
    return { policies, stats, state };
  };
  const run = (rules: PolicyRule[], catalog: Catalog) =>
    visibleCatalog({ policies: fake(rules).policies, auth, ...CONTEXT }, catalog);

  /** The original algorithm: one full `evaluatePolicy` per table and per column. */
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
        { policyVersion: 'v' },
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
    expect(stats.tables + stats.columns).toBe(0);
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
      [{ ...base, columns: ['COL*'] }],
      [{ ...base, columns: ['*'], entities: ['TGF*'] }],
      [{ ...base, columns: ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'NOMEPARC'] }],
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
    const one = <T>(xs: readonly T[]) => [xs[Math.floor(rnd() * xs.length)]!];
    const COLUMN_PATTERNS = [
      'TGFPAR.EMAIL',
      'EMAIL',
      'CPF',
      'CODCID',
      'NOME*',
      'COL*',
      '*COL*',
      'AD_*.COL1',
      '*',
    ];
    const random = (): PolicyRule[] =>
      Array.from({ length: 1 + Math.floor(rnd() * 5) }, (_, i) => {
        const kind = rnd();
        return {
          ...base,
          id: `r${i}`,
          effect: rnd() < 0.75 ? 'DENY' : 'ALLOW',
          subjectType: rnd() < 0.6 ? 'everyone' : 'group',
          subjectId: rnd() < 0.5 ? 'g1' : 'g2',
          environments: some(['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'] as const),
          connectionIds: some(['c1', 'c2']),
          // Bare column denies, count-only (`*`) rules and broad wildcards are frequent.
          entities: kind < 0.5 ? [] : some(['TGFPAR', 'TGF*', 'TSICID', 'SYS.*', 'AD_*']),
          columns:
            kind < 0.2
              ? []
              : kind < 0.5
                ? one(COLUMN_PATTERNS)
                : kind < 0.65
                  ? ['*']
                  : some(COLUMN_PATTERNS),
        };
      });
    const catalog: Catalog = {
      ...CATALOG,
      tables: [
        table('TGFPAR', ['CODPARC', 'NOMEPARC', 'EMAIL', 'CODCID', 'CPF']),
        table('TSICID', ['CODCID', 'NOMECID']),
        table('TGFPRO', ['CODPROD', 'DESCRPROD', 'COL1']),
        table('TGFEMPTY', []),
        table('AD_X', ['NOMEX', 'EMAIL', 'COL1', 'XCOLY', 'COL2']),
      ],
    };
    const total = (shaped: Record<string, string[]>) =>
      Object.values(shaped).reduce((n, cols) => n + cols.length, 0);
    const sets = [...fixed, ...Array.from({ length: 300 }, random)];
    let tablesHidden = 0;
    let columnsHidden = 0;
    for (const rules of sets) {
      const out = await run(rules, catalog);
      const expected = reference(rules, catalog);
      expect(shape(out), JSON.stringify(rules)).toEqual(expected);
      if (Object.keys(expected).length < catalog.tables.length) tablesHidden++;
      else if (total(expected) < total(shape(catalog))) columnsHidden++;
    }
    // The sets exercise every outcome: tables hidden, only columns hidden, nothing hidden.
    expect(tablesHidden).toBeGreaterThan(30);
    expect(columnsHidden).toBeGreaterThan(30);
    expect(tablesHidden + columnsHidden).toBeLessThan(sets.length - 30);
  });

  describe('findVisibleTable', () => {
    const DENY_TABLE: PolicyRule = { ...DENY_EMAIL, id: 'r2', entities: ['TGFXYZ'], columns: [] };
    const found = table('TGFXYZ', ['X']);

    it('reads a table the user may see from the dictionary', async () => {
      const lookup = vi.fn(async () => found);
      const check = { policies: fake([DENY_EMAIL]).policies, auth, ...CONTEXT };
      expect(await findVisibleTable(check, 'TGFXYZ', lookup)).toBe(found);
      expect(lookup).toHaveBeenCalledWith('TGFXYZ');
    });

    it('answers a hidden table as a missing one, without reading the dictionary', async () => {
      const lookup = vi.fn(async () => found);
      const check = { policies: fake([DENY_TABLE]).policies, auth, ...CONTEXT };
      expect(await findVisibleTable(check, 'TGFXYZ', lookup)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });

    it('fails closed: a failed lookup or policy filter finds nothing', async () => {
      const check = { policies: fake([]).policies, auth, ...CONTEXT };
      const failing = vi.fn(async () => {
        throw new Error('gateway down');
      });
      expect(await findVisibleTable(check, 'TGFXYZ', failing)).toBeUndefined();
      const broken = {
        ...check,
        policies: { denyChecker: () => Promise.resolve(null) } as unknown as PolicyService,
      };
      const lookup = vi.fn(async () => found);
      expect(await findVisibleTable(broken, 'TGFXYZ', lookup)).toBeUndefined();
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('on 5,000 tables of 31 columns', () => {
    const columns = Array.from({ length: 30 }, (_, i) => `COL${i}`);
    const big: Catalog = {
      ...CATALOG,
      tables: Array.from({ length: 5000 }, (_, i) =>
        table(i % 2 ? `TGF${i}` : `AD_T${i}`, [...columns, 'CODUSU']),
      ),
    };
    const nonMatching: PolicyRule[] = Array.from({ length: 50 }, (_, i) => ({
      ...DENY_EMAIL,
      id: `n${i}`,
      columns: ['CODUSU'],
      subjectType: 'user',
      subjectId: `other-${i}`,
    }));
    const timed = async (rules: PolicyRule[]) => {
      const { policies, stats } = fake(rules);
      const started = performance.now();
      const out = await visibleCatalog({ policies, auth, ...CONTEXT }, big);
      return { out, stats, ms: performance.now() - started };
    };

    it('serves the same catalog with no check when 50 rules do not apply', async () => {
      const { out, stats, ms } = await timed(nonMatching);
      expect(out).toBe(big);
      expect(stats.tables + stats.columns).toBe(0);
      expect(ms).toBeLessThan(1500);
    });

    it('applies 30 bare column denies (all but one column hidden) in linear time', async () => {
      const pii = columns.map((name, i) => ({ ...DENY_EMAIL, id: `pii${i}`, columns: [name] }));
      const { out, stats, ms } = await timed([...nonMatching, ...pii]);
      expect(ms).toBeLessThan(1500);
      expect(out.tables).toHaveLength(5000);
      expect(out.tables.every((t: CatalogTable) => t.columns.length === 1)).toBe(true);
      // One decision per table and one per column, never more.
      expect(stats.tables).toBe(5000);
      expect(stats.columns).toBe(5000 * 31);
    });

    it('applies a broad COL* deny and a count-only rule in linear time', async () => {
      const { out, stats, ms } = await timed([
        ...nonMatching,
        { ...DENY_EMAIL, id: 'broad', columns: ['COL*'] },
        { ...DENY_EMAIL, id: 'count-only', entities: ['AD_*'], columns: ['*'] },
      ]);
      expect(ms).toBeLessThan(1500);
      expect(out.tables).toHaveLength(5000);
      for (const t of out.tables) {
        expect(t.columns.map((c) => c.name)).toEqual(t.name.startsWith('AD_') ? [] : ['CODUSU']);
      }
      expect(stats.columns).toBe(5000 * 31);
    });

    it('yields to the event loop while it works', async () => {
      const { policies } = fake([{ ...DENY_EMAIL, columns: ['COL*'] }]);
      let ticks = 0;
      let done = false;
      const tick = () => {
        ticks++;
        if (!done) setImmediate(tick);
      };
      setImmediate(tick);
      const started = performance.now();
      await visibleCatalog({ policies, auth, ...CONTEXT }, big);
      const ms = performance.now() - started;
      done = true;
      // About 10 ms of work between two turns of the loop; checked with a generous margin.
      if (ms > 50) expect(ticks).toBeGreaterThanOrEqual(Math.floor(ms / 50));
    });

    it('answers a repeated call from the memo, near instantly', async () => {
      const { policies, stats } = fake(
        [...nonMatching, { ...DENY_EMAIL, columns: ['COL*'] }],
        'v1',
      );
      const first = await visibleCatalog({ policies, auth, ...CONTEXT }, big);
      const decided = stats.tables + stats.columns;
      expect(decided).toBeGreaterThan(0);
      const started = performance.now();
      const second = await visibleCatalog({ policies, auth, ...CONTEXT }, big);
      expect(performance.now() - started).toBeLessThan(50);
      expect(second).toBe(first);
      expect(stats.tables + stats.columns).toBe(decided);
    });
  });

  describe('memo', () => {
    it('is invalidated by a policy change and keyed by caller, groups, connection, environment and catalog', async () => {
      const { policies, stats, state } = fake([DENY_EMAIL], 'v1');
      const call = (over: Partial<typeof CONTEXT> = {}, catalog = withFks, user = auth) =>
        visibleCatalog({ policies, auth: user, ...CONTEXT, ...over }, catalog);
      const first = await call();
      expect(shape(first).TGFPAR).not.toContain('EMAIL');
      expect(await call()).toBe(first);
      const base = stats.tables;

      // A policy change gives another version: the memo misses and the new rules apply.
      state.rules = [{ ...DENY_EMAIL, columns: ['NOMEPARC'] }];
      state.version = 'v2';
      const changed = await call();
      expect(shape(changed).TGFPAR).toEqual(['CODPARC', 'EMAIL', 'CODCID']);
      expect(stats.tables).toBe(base + withFks.tables.length);

      // Every other part of the key misses too.
      const before = stats.tables;
      await call({ groupIds: ['g2'] });
      await call({ connectionId: 'c2' });
      await call({ environment: 'PRODUCTION' });
      await call({}, { ...withFks });
      await call({}, withFks, { ...auth, user: { id: 'u2' } } as unknown as AuthState);
      expect(stats.tables).toBe(before + 5 * withFks.tables.length);

      // The group order does not matter.
      const at = stats.tables;
      await call({ groupIds: ['g2', 'g1'] });
      await call({ groupIds: ['g1', 'g2'] });
      expect(stats.tables).toBe(at + withFks.tables.length);
    });

    it('releases a refreshed catalog and its results, keeping only the latest per connection', async () => {
      const { policies, stats } = fake([DENY_EMAIL], 'v1');
      const call = (catalog: Catalog, userId = 'u1', connectionId = 'c1') =>
        visibleCatalog(
          {
            policies,
            auth: { ...auth, user: { id: userId } } as AuthState,
            ...CONTEXT,
            connectionId,
          },
          catalog,
        );
      await call(withFks);
      await call(withFks, 'u2');
      expect(memoizedCatalogs(policies)).toEqual([
        { connectionId: 'c1', catalog: withFks, results: 2 },
      ]);

      // A refresh hands over a new object (same fetchedAt or not): it never hits the old entry,
      // and the old catalog with its results is no longer reachable from the memo.
      const sameTime = { ...withFks };
      const before = stats.tables;
      await call(sameTime);
      expect(stats.tables).toBe(before + withFks.tables.length);
      const refreshed = { ...withFks, fetchedAt: '2026-01-01T01:00:00.000Z' };
      await call(refreshed);
      expect(stats.tables).toBe(before + 2 * withFks.tables.length);
      const held = memoizedCatalogs(policies);
      expect(held).toEqual([{ connectionId: 'c1', catalog: refreshed, results: 1 }]);
      expect(held.some((m) => m.catalog === withFks || m.catalog === sameTime)).toBe(false);

      // Other connections keep their own latest catalog.
      await call(withFks, 'u1', 'c2');
      expect(memoizedCatalogs(policies).map((m) => [m.connectionId, m.catalog])).toEqual([
        ['c1', refreshed],
        ['c2', withFks],
      ]);
    });

    it('does not reinstate a catalog refreshed while it was being filtered', async () => {
      const { policies, stats } = fake([DENY_EMAIL], 'v1');
      const call = (catalog: Catalog) => visibleCatalog({ policies, auth, ...CONTEXT }, catalog);
      const refreshed = { ...withFks, fetchedAt: '2026-01-01T01:00:00.000Z' };
      // The first table decision takes longer than a slice, so the stale filter yields mid-way
      // and the refreshed call completes in between.
      const slow = policies.denyChecker.bind(policies);
      policies.denyChecker = async (...args: Parameters<PolicyService['denyChecker']>) => {
        const checker = await slow(...args);
        return (
          checker && {
            ...checker,
            forTable: (t: string) => {
              if (stats.tables === 0)
                for (const end = performance.now() + 15; performance.now() < end;);
              return checker.forTable(t);
            },
          }
        );
      };
      let refreshedDone = false;
      const stale = call(withFks);
      const fresh = call(refreshed).then(() => (refreshedDone = true));
      await stale;
      await fresh;
      expect(refreshedDone).toBe(true);
      expect(memoizedCatalogs(policies)).toEqual([
        { connectionId: 'c1', catalog: refreshed, results: 1 },
      ]);
    });

    it('bounds the results per catalog and the connections, dropping the least recently used', async () => {
      const { policies } = fake([DENY_EMAIL], 'v1');
      const call = (userId: string, connectionId = 'c1') =>
        visibleCatalog(
          {
            policies,
            auth: { ...auth, user: { id: userId } } as AuthState,
            ...CONTEXT,
            connectionId,
          },
          withFks,
        );
      for (let i = 0; i < 70; i++) await call(`u${i}`);
      expect(memoizedCatalogs(policies)[0]?.results).toBe(64);
      for (let i = 0; i < 40; i++) await call('u1', `k${i}`);
      const held = memoizedCatalogs(policies).map((m) => m.connectionId);
      expect(held).toHaveLength(32);
      expect(held).not.toContain('c1');
      expect(held).toEqual(Array.from({ length: 32 }, (_, i) => `k${i + 8}`));
    });

    it('never remembers a failure', async () => {
      const { policies, state } = fake([{ ...DENY_EMAIL, actions: [] }], 'v1');
      const call = () => visibleCatalog({ policies, auth, ...CONTEXT }, withFks);
      expect((await call()).degraded).toEqual([POLICY_FILTER_FAILED]);
      state.rules = [DENY_EMAIL];
      expect((await call()).degraded).toBeUndefined();
    });
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
