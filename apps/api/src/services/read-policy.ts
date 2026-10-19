/**
 * Glue between the read and scratch paths and the policy engine: what a statement touches, in
 * the shape `PolicyService.evaluate` expects, and the per-connection authorization check.
 */
import { AppError } from '@dbx/shared';
import type { Environment, Permission, PolicyColumn, PolicyDecision } from '@dbx/shared';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { ConnectionsService } from './connections';
import type { Catalog } from './metadata';
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
 * DENY on that table hits. Callers must have checked every table against the catalog.
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
