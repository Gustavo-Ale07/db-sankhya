/**
 * Glue between the read and scratch paths and the policy engine: what a statement touches, in
 * the shape `PolicyService.evaluate` expects, and the per-connection authorization check.
 */
import { AppError, isPlainPolicyName } from '@dbx/shared';
import type {
  DenyChecker,
  Environment,
  Permission,
  PolicyColumn,
  PolicyDecision,
} from '@dbx/shared';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { ConnectionsService } from './connections';
import type { Catalog, CatalogColumn, CatalogTable } from './metadata';
import type { PolicyService } from './policy';

/**
 * Policy context of the scratch workspaces. They are not a Sankhya connection, so rules reach
 * them through this pseudo connection id (no stored rule can name it, as `connectionIds` holds
 * uuids) and the SANDBOX environment: a rule with no connection list that covers SANDBOX (or every
 * environment) applies to scratch.
 */
export const SCRATCH_CONNECTION_ID = 'scratch';
export const SCRATCH_ENVIRONMENT: Environment = 'SANDBOX';

/**
 * The one answer for a connection the user may not use, whether it exists or not, so a denied
 * user cannot probe which connection ids exist.
 */
export function connectionDenied(): AppError {
  return new AppError('FORBIDDEN', 'You do not have access to this connection');
}

export interface ReadTargets {
  /** Base tables, upper-cased, each once. */
  entities: string[];
  /** Every referenced column, attributed to the tables it may belong to. */
  columns: PolicyColumn[];
}

/**
 * Entities and columns of an analyzed read, for the policy request. Attribution fails closed: a
 * column (or star) whose qualifier names no base table or alias (a CTE, a derived table) and an
 * unqualified column are attributed to every base table of the statement. A star is expanded
 * from the catalog; when the catalog has no columns for a table, it stays `*`, which every column
 * DENY on that table hits. `COUNT(*)` is not expanded (it reads no column value); `COUNT(col)` is
 * an ordinary column reference. Callers must have checked every table against the catalog.
 */
export function readTargets(analysis: ReadAnalysis, catalog: Catalog): ReadTargets {
  const entities = [...new Set(analysis.tables.map((t) => t.name.toUpperCase()))];
  const byQualifier = new Map<string, Set<string>>();
  const addQualifier = (q: string, table: string) => {
    const key = q.toUpperCase();
    const set = byQualifier.get(key) ?? new Set<string>();
    set.add(table);
    byQualifier.set(key, set);
  };
  for (const t of analysis.tables) {
    const name = t.name.toUpperCase();
    addQualifier(t.name, name);
    if (t.alias) addQualifier(t.alias, name);
  }
  const owners = (qualifier: string | undefined): string[] => {
    const hit = qualifier === undefined ? undefined : byQualifier.get(qualifier.toUpperCase());
    return hit ? [...hit] : entities;
  };
  const catalogColumns = new Map(
    catalog.tables.map((t) => [t.name.toUpperCase(), t.columns.map((c) => c.name)]),
  );

  const seen = new Set<string>();
  const columns: PolicyColumn[] = [];
  const push = (table: string, name: string) => {
    const key = `${table}\u0000${name.toUpperCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    columns.push({ table, name });
  };
  for (const c of analysis.columns) for (const t of owners(c.table)) push(t, c.name);
  for (const s of analysis.star) {
    // COUNT(*) counts rows and reads no column value; any other star is expanded.
    if (s.inAggregate) continue;
    for (const t of owners(s.table)) {
      const cols = catalogColumns.get(t) ?? [];
      if (cols.length === 0) push(t, '*');
      else for (const name of cols) push(t, name);
    }
  }
  return { entities, columns };
}

export interface PolicyCheck {
  policies: PolicyService;
  auth: AuthState;
  groupIds: string[];
  action: Permission;
  environment: Environment;
  connectionId: string;
  entities: string[];
  columns?: PolicyColumn[];
  hasWhere?: boolean;
  /** Operator row ceilings (clamped by the evaluator to its hard maxima). */
  defaults?: { maxReadRows?: number; maxWriteRows?: number };
}

/** One policy evaluation for the authenticated user. Never throws (evaluate fails closed). */
export function evaluateFor(check: PolicyCheck): Promise<PolicyDecision> {
  return check.policies.evaluate(
    {
      userId: check.auth.user.id,
      groupIds: check.groupIds,
      action: check.action,
      environment: check.environment,
      connectionId: check.connectionId,
      entities: check.entities,
      ...(check.columns ? { columns: check.columns } : {}),
      hasWhere: check.hasWhere ?? false,
    },
    new Set<Permission>(check.auth.grants.permissions),
    check.defaults ? { defaults: check.defaults } : {},
  );
}

export type ConnectionAccess =
  | { ok: true; environment: Environment; decision: PolicyDecision }
  /** Denied or unknown: callers answer both with `connectionDenied()`. */
  | { ok: false; reasons: string[] };

/**
 * Authorizes `action` on a whole connection before its runtime or catalog is touched. The
 * environment comes from the connection itself (for `env-default`, from SANKHYA_ENVIRONMENT).
 * Only rules without entities or columns can deny a whole connection; entity and column rules are
 * checked per statement.
 */
export async function authorizeConnection(
  check: Omit<PolicyCheck, 'environment' | 'entities' | 'columns' | 'hasWhere'> & {
    connections: ConnectionsService;
  },
): Promise<ConnectionAccess> {
  let environment: Environment;
  try {
    environment = (await check.connections.get(check.connectionId)).environment;
  } catch (err) {
    if (err instanceof AppError && err.code === 'NOT_FOUND') {
      return { ok: false, reasons: ['unknown connection'] };
    }
    throw err;
  }
  const decision = await evaluateFor({ ...check, environment, entities: [], columns: [] });
  if (decision.effect !== 'ALLOW') return { ok: false, reasons: decision.reasons };
  return { ok: true, environment, decision };
}

/** Catalog marker of a filter that failed closed (`degraded` is free-form `SOURCE:state`). */
export const POLICY_FILTER_FAILED = 'POLICY:failed';

/** Longest run of filtering, in milliseconds, before yielding to the event loop. */
const SLICE_MS = 10;

/** Filtered results remembered per catalog (most recently used last). */
const MEMO_RESULTS = 64;
/** Connections whose catalog has results remembered, per policy service. */
const MEMO_CONNECTIONS = 32;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The filtered results of one catalog object, by caller and policy version. */
interface CatalogMemo {
  catalog: Catalog;
  results: Map<string, Catalog>;
}

/**
 * Memo of filtered catalogs, one per `PolicyService` (so separate apps never share one): per
 * connection, only the results of the last catalog object seen for it. A refreshed catalog (a
 * new object) replaces the slot, so the stale catalog and its results are released with it
 * rather than pinned until evicted. Both levels are bounded LRUs.
 */
const memos = new WeakMap<PolicyService, Map<string, CatalogMemo>>();

/** The results remembered for `catalog` on `connectionId`, made current (and most recent). */
function memoFor(policies: PolicyService, connectionId: string, catalog: Catalog) {
  let byConnection = memos.get(policies);
  if (!byConnection) {
    byConnection = new Map();
    memos.set(policies, byConnection);
  }
  let slot = byConnection.get(connectionId);
  if (!slot || slot.catalog !== catalog) slot = { catalog, results: new Map() };
  byConnection.delete(connectionId);
  byConnection.set(connectionId, slot);
  while (byConnection.size > MEMO_CONNECTIONS) {
    byConnection.delete(byConnection.keys().next().value as string);
  }
  return slot.results;
}

/**
 * For tests: the catalog objects the memo of `policies` keeps, with how many results each, by
 * connection. Anything not listed is not reachable from the memo.
 */
export function memoizedCatalogs(
  policies: PolicyService,
): Array<{ connectionId: string; catalog: Catalog; results: number }> {
  return [...(memos.get(policies) ?? new Map<string, CatalogMemo>())].map(([id, slot]) => ({
    connectionId: id,
    catalog: slot.catalog,
    results: slot.results.size,
  }));
}

/**
 * The part of `catalog` the user may read with QUERY.SELECT, so the schema browser and
 * autocomplete never disclose names a read would be denied on. It decides exactly what
 * `evaluateFor` decides on the read path: a table is omitted when `{ entities: [T], columns: [] }`
 * (a `COUNT(*)`) is denied, and a column when `{ entities: [T], columns: [T.C] }` is denied. A
 * foreign key that names an omitted table or column at either end is omitted too. The shape of
 * the catalog is unchanged.
 *
 * Cost:
 * - The rule set is read and compiled once per call (`PolicyService.denyChecker`), keeping only
 *   the DENY rules that match this user, groups, connection and environment. With none, and only
 *   plain names, the catalog is returned as is.
 * - Otherwise each table is decided once against those rules (`DenyChecker.forTable`), which
 *   also collects the column patterns that can reach it; each column is then a set lookup or a
 *   few globs against only those patterns. Linear in tables and columns, whatever is denied.
 * - The loop yields to the event loop after every `SLICE_MS` of work.
 * - The result is memoized per user, groups, connection, environment, policy version and catalog
 *   object, so repeated calls cost a lookup; any policy change alters the version and misses. Only
 *   the latest catalog object of each connection is kept, so a refresh releases the stale one.
 *
 * Fails closed: if the rules cannot be compiled, or anything throws, no table is returned and
 * `degraded` gains `POLICY:failed`. `onError` is only told; it cannot turn this into a throw.
 * A failed result is never memoized.
 */
export async function visibleCatalog(
  check: Omit<PolicyCheck, 'action' | 'entities' | 'columns' | 'hasWhere' | 'defaults'>,
  catalog: Catalog,
  onError?: (err: unknown) => void,
): Promise<Catalog> {
  const failed = (err: unknown): Catalog => {
    try {
      onError?.(err);
    } catch {
      // Reporting must never turn the fail-closed answer into an error.
    }
    return {
      ...catalog,
      tables: [],
      degraded: [...(catalog.degraded ?? []), POLICY_FILTER_FAILED],
    };
  };
  try {
    const checker = await check.policies.denyChecker(
      {
        userId: check.auth.user.id,
        groupIds: check.groupIds,
        action: 'QUERY.SELECT',
        environment: check.environment,
        connectionId: check.connectionId,
      },
      new Set<Permission>(check.auth.grants.permissions),
    );
    if (!checker) return failed(new Error('policy rules unavailable for this context'));
    if (checker.denyRules === 0 && allPlain(catalog)) return catalog;
    // Without a known version two calls cannot be told apart, so nothing is remembered.
    if (typeof checker.policyVersion !== 'string') return await filterCatalog(checker, catalog);
    const key = JSON.stringify([
      checker.policyVersion,
      check.auth.user.id,
      [...check.groupIds].sort(),
      check.environment,
    ]);
    const memo = memoFor(check.policies, check.connectionId, catalog);
    const hit = memo.get(key);
    if (hit) {
      memo.delete(key);
      memo.set(key, hit);
      return hit;
    }
    const result = await filterCatalog(checker, catalog);
    // Into this catalog's own map: if a refresh replaced it meanwhile, the map is already
    // unreachable and the result goes with it, never reinstating the stale catalog.
    memo.delete(key);
    memo.set(key, result);
    while (memo.size > MEMO_RESULTS) memo.delete(memo.keys().next().value as string);
    return result;
  } catch (err) {
    return failed(err);
  }
}

function allPlain(catalog: Catalog): boolean {
  return catalog.tables.every(
    (t) => isPlainPolicyName(t.name) && t.columns.every((c) => isPlainPolicyName(c.name)),
  );
}

async function filterCatalog(checker: DenyChecker, catalog: Catalog): Promise<Catalog> {
  const kept: CatalogTable[] = [];
  const hiddenTables = new Set<string>();
  /** Denied columns per upper-cased table; made into name sets only if a foreign key asks. */
  const deniedByTable = new Map<string, CatalogColumn[]>();
  let sliceStart = performance.now();
  for (const table of catalog.tables) {
    if (performance.now() - sliceStart >= SLICE_MS) {
      await yieldToLoop();
      sliceStart = performance.now();
    }
    const entity = table.name.toUpperCase();
    const verdict = checker.forTable(entity);
    if (!verdict) {
      hiddenTables.add(entity);
      continue;
    }
    // Copied only from the first denied column on, so an untouched table is kept as is.
    let visible: CatalogColumn[] | null = null;
    const denied: CatalogColumn[] = [];
    table.columns.forEach((c, i) => {
      if (verdict.columnDenied(c.name)) {
        visible ??= table.columns.slice(0, i);
        denied.push(c);
      } else visible?.push(c);
    });
    if (!visible) {
      kept.push(table);
      continue;
    }
    deniedByTable.set(entity, [...(deniedByTable.get(entity) ?? []), ...denied]);
    kept.push({ ...table, columns: visible });
  }
  if (hiddenTables.size === 0 && deniedByTable.size === 0) return catalog;
  const names = new Map<string, Set<string>>();
  const columnHidden = (table: string, column: string) => {
    const t = table.toUpperCase();
    const cols = deniedByTable.get(t);
    if (!cols) return false;
    let set = names.get(t);
    if (!set) {
      set = new Set(cols.map((c) => c.name.toUpperCase()));
      names.set(t, set);
    }
    return set.has(column.toUpperCase());
  };
  const tables = kept.map((t) => {
    if (t.foreignKeys.length === 0) return t;
    const foreignKeys = t.foreignKeys.filter(
      (fk) =>
        !columnHidden(t.name, fk.column) &&
        !hiddenTables.has(fk.refTable.toUpperCase()) &&
        !columnHidden(fk.refTable, fk.refColumn),
    );
    return foreignKeys.length === t.foreignKeys.length ? t : { ...t, foreignKeys };
  });
  return { ...catalog, tables };
}
