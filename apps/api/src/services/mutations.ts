/**
 * Mutation orchestrator, preview half (Task 11.2a). `prepare` runs
 * PARSE → VALIDATE → AUTHORIZE → PLAN → PREVIEW → IMPACT and persists an immutable plan. It never
 * writes: the only gateway call it can make is the before-snapshot read (`executeQuery` through
 * `executeRead`). Execution (Task 11.2b) does not exist yet, so nothing can consume the plan.
 */
import { AppError, isAppError } from '@dbx/shared';
import type { Environment, Permission, PolicyColumn, PolicyDecision } from '@dbx/shared';
import { classifyStatement, resolveCapability } from '@dbx/sql-engine';
import type {
  Capability,
  Classified,
  Expr,
  InsertStatement,
  UpdateStatement,
  Value,
} from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { AuthzService } from './authz';
import type { ConnectionsService } from './connections';
import type { Catalog, CatalogTable } from './metadata';
import type { MetadataService } from './metadata';
import type { PlansService } from './plans';
import { strongConfirmationPhrase } from './plans';
import type { PolicyService } from './policy';
import { executeRead } from './read-executor';
import { authorizeConnection, connectionDenied, evaluateFor, readTargets } from './read-policy';
import type { AuditService } from './records';

export type PreviewKind =
  'SIMULATED_PREVIEW' | 'IMPACT_ANALYSIS+SIMULATED_PREVIEW' | 'TRANSACTIONAL_DRY_RUN';

export type RecordValues = Record<string, Value>;

export interface PreviewTarget {
  key: RecordValues;
  before: RecordValues | null;
  after: RecordValues;
}

export interface PreparedMutation {
  planId: string;
  token: string;
  expiresAt: string;
  capability: Capability;
  /** UPDATE carries both labels: IMPACT_ANALYSIS (real before values) + SIMULATED_PREVIEW. */
  previewKind: PreviewKind;
  preview: { targets: PreviewTarget[]; affected: number };
  impact: { entities: string[]; rows: number; environment: Environment };
  requires: { strongConfirmation: string | null; approval: boolean };
}

export interface PrepareContext {
  auth: AuthState;
  connectionId: string;
  sql: string;
  /** Request metadata for the audit trail. */
  meta?: { ip?: string | null; requestId?: string | null };
}

export interface MutationDeps {
  policies: PolicyService;
  authz: Pick<AuthzService, 'activeGroupIds'>;
  connections: ConnectionsService;
  metadata: Pick<MetadataService, 'get'>;
  plans: Pick<PlansService, 'create'>;
  audit: AuditService;
  /** SANKHYA_MAX_ROWS: ceiling of the before-snapshot read. */
  maxReadRows: number;
}

type WriteClassified = Extract<Classified, { kind: 'INSERT' | 'UPDATE' | 'DELETE' }>;

const PERMISSION: Record<WriteClassified['kind'], Permission> = {
  INSERT: 'DATA.INSERT',
  UPDATE: 'DATA.UPDATE',
  DELETE: 'DATA.DELETE',
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** A refusal with the stage that produced it and audit-only details (never sent to the user). */
class Refusal extends AppError {
  constructor(
    readonly stage: string,
    err: AppError,
    readonly internal: Record<string, unknown> = {},
  ) {
    super(err.code, err.message, err.details);
  }
}

const refuse = (stage: string, err: AppError, internal?: Record<string, unknown>) =>
  new Refusal(stage, err, internal);

export class MutationService {
  constructor(private readonly deps: MutationDeps) {}

  async prepare(ctx: PrepareContext): Promise<PreparedMutation> {
    const { auth, sql } = ctx;
    let classified: Classified | undefined;
    let environment: Environment | null = null;
    try {
      // ---------------------------------------------------------------- PARSE
      // AST classification only: anything the parser cannot positively identify is refused.
      classified = classifyStatement(sql);
      if (classified.kind === 'UNKNOWN') {
        throw refuse(
          'PARSE',
          new AppError('SQL_PARSE_ERROR', 'The statement could not be recognised.'),
          { reason: classified.reason },
        );
      }
      if (
        classified.kind !== 'INSERT' &&
        classified.kind !== 'UPDATE' &&
        classified.kind !== 'DELETE'
      ) {
        throw refuse(
          'PARSE',
          new AppError('SQL_UNSUPPORTED', 'Only INSERT, UPDATE and DELETE can be previewed.'),
        );
      }
      const write = classified;

      // ---------------------------------------------------------------- VALIDATE
      if (write.kind !== 'INSERT' && !write.hasWhere) {
        throw refuse(
          'VALIDATE',
          new AppError(
            'WHERE_REQUIRED',
            `${write.kind} without WHERE affects every row and is blocked.`,
          ),
        );
      }

      if (write.kind !== 'INSERT' && write.stmt && 'where' in write.stmt && write.stmt.where) {
        if (isTrivialWhere(write.stmt.where)) {
          throw refuse(
            'VALIDATE',
            new AppError(
              'WHERE_REQUIRED',
              `${write.kind} with a condition that does not restrict rows is blocked.`,
            ),
          );
        }
      }

      // ---------------------------------------------------------------- AUTHORIZE
      const permission = PERMISSION[write.kind];
      if (!auth.grants.permissions.has(permission)) {
        throw refuse(
          'AUTHORIZE',
          new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
        );
      }
      const { policies, connections, metadata } = this.deps;
      const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
      // The connection is authorized for reading first: the preview reads the targets, and a
      // write request without entities is always denied by the engine. The write itself is
      // authorized per entity below.
      const access = await authorizeConnection({
        policies,
        auth,
        groupIds,
        action: 'QUERY.SELECT',
        connectionId: ctx.connectionId,
        connections,
      });
      if (!access.ok) throw refuse('AUTHORIZE', connectionDenied(), { reasons: access.reasons });
      environment = access.environment;

      const catalog = await metadata.get(ctx.connectionId);
      const capability = resolveCapability(write, { catalog, scratchTables: [] });
      if (capability.class === 'UNSUPPORTED' || capability.route !== 'SANKHYA_SAVE') {
        throw refuse(
          'AUTHORIZE',
          new AppError('OPERATION_NOT_SUPPORTED', capability.reason, {
            capability: capability.class,
          }),
        );
      }
      if (capability.blocked) {
        throw refuse('VALIDATE', new AppError('WHERE_REQUIRED', capability.blocked.reason));
      }
      const stmt = write.stmt;
      if (!stmt || stmt.type === 'delete') {
        throw refuse(
          'VALIDATE',
          new AppError('OPERATION_NOT_SUPPORTED', 'This statement shape cannot be previewed.'),
        );
      }
      const table = catalogTable(catalog, write.table);

      const decision = await evaluateFor({
        policies,
        auth,
        groupIds,
        action: permission,
        environment,
        connectionId: ctx.connectionId,
        entities: [table.name.toUpperCase()],
        columns: writeColumns(stmt, table),
        hasWhere: write.hasWhere,
      });
      if (decision.effect !== 'ALLOW') {
        throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The change was denied by policy'), {
          reasons: decision.reasons,
          matchedRuleIds: decision.matchedRuleIds,
          policyVersion: decision.policyVersion,
        });
      }

      // ---------------------------------------------------------------- PLAN + PREVIEW
      const maxWriteRows = decision.limits.maxWriteRows;
      let targets: PreviewTarget[];
      let previewKind: PreviewKind;
      if (stmt.type === 'insert') {
        targets = [insertTarget(stmt, table)];
        previewKind = 'SIMULATED_PREVIEW';
      } else {
        targets = await this.updateTargets(ctx, stmt, table, catalog, {
          groupIds,
          environment,
          maxWriteRows,
        });
        previewKind = 'IMPACT_ANALYSIS+SIMULATED_PREVIEW';
      }
      if (targets.length > maxWriteRows) {
        throw refuse(
          'PREVIEW',
          new AppError(
            'WRITE_ROW_LIMIT_EXCEEDED',
            `The change affects more than ${maxWriteRows} rows.`,
            { maxWriteRows },
          ),
        );
      }

      // ---------------------------------------------------------------- IMPACT
      const affected = targets.length;
      const entity = table.name.toUpperCase();
      const preview = { targets, affected };
      const created = await this.deps.plans.create({
        userId: auth.user.id,
        sessionId: auth.session.id,
        connectionId: ctx.connectionId,
        environment,
        sql,
        params: null,
        capability,
        decision,
        targets,
        preview,
        previewKind,
        summary: { action: write.kind, count: affected, entity },
      });
      const needsPhrase = decision.limits.requireStrongConfirmation || environment === 'PRODUCTION';
      const prepared: PreparedMutation = {
        planId: created.id,
        token: created.token,
        expiresAt: created.expiresAt.toISOString(),
        capability,
        previewKind,
        preview,
        impact: { entities: [entity], rows: affected, environment },
        requires: {
          strongConfirmation: needsPhrase
            ? strongConfirmationPhrase(environment, write.kind, affected, entity)
            : null,
          approval: decision.limits.requireApproval,
        },
      };
      await this.deps.audit.recordPlanCreated(
        {
          userId: auth.user.id,
          userEmail: auth.user.email,
          ip: ctx.meta?.ip ?? null,
          requestId: ctx.meta?.requestId ?? null,
          connectionId: ctx.connectionId,
          environment,
          planId: created.id,
          planHash: created.planHash,
          capability: permission,
        },
        {
          statement: sql,
          policyDecision: policySummary(decision),
          details: { operation: write.kind, resource: entity, affected, previewKind },
          before: targets.flatMap((t) => (t.before ? [t.before] : [])),
          after: targets.map((t) => t.after),
        },
      );
      return prepared;
    } catch (err) {
      await this.auditRefusal(ctx, classified, environment, err);
      if (err instanceof Refusal) throw new AppError(err.code, err.message, err.details);
      throw err;
    }
  }

  /** Before snapshot of the UPDATE targets through the read path, capped at maxWriteRows + 1. */
  private async updateTargets(
    ctx: PrepareContext,
    stmt: UpdateStatement,
    table: CatalogTable,
    catalog: Catalog,
    opts: { groupIds: string[]; environment: Environment; maxWriteRows: number },
  ): Promise<PreviewTarget[]> {
    const pk = table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    if (pk.length === 0) {
      throw refuse(
        'PLAN',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          `${table.name} has no known primary key: its rows cannot be identified.`,
        ),
      );
    }
    const qualifiers = new Set([table.name.toUpperCase()]);
    if (stmt.table.alias) qualifiers.add(stmt.table.alias.toUpperCase());
    const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
    const setColumns = stmt.set.map((s) => columnOf(s.column, known));
    for (const c of setColumns) {
      if (pk.includes(c))
        throw refuse(
          'VALIDATE',
          new AppError(
            'COLUMN_NOT_WRITABLE',
            `${c} is part of the primary key and cannot be changed.`,
          ),
        );
    }
    const referenced = new Set<string>();
    for (const s of stmt.set) collectColumns(s.value, qualifiers, known, referenced);
    const selected = [...new Set([...pk, ...setColumns, ...referenced])];
    if (!stmt.where) throw refuse('VALIDATE', new AppError('WHERE_REQUIRED', 'WHERE is required.'));
    const where = renderExpr(stmt.where, qualifiers, known);
    const snapshotSql = `SELECT ${selected.join(', ')} FROM ${table.name.toUpperCase()} WHERE ${where}`;

    const { policies, connections } = this.deps;
    const runtime = await connections.getRuntime(ctx.connectionId);
    const maxRows = Math.max(1, Math.min(this.deps.maxReadRows, opts.maxWriteRows));
    const out = await executeRead({
      runtime,
      catalog,
      sql: snapshotSql,
      maxRows,
      signal: new AbortController().signal,
      decide: async (analysis) => {
        const t = readTargets(analysis, catalog);
        const read = await evaluateFor({
          policies,
          auth: ctx.auth,
          groupIds: opts.groupIds,
          action: 'QUERY.SELECT',
          environment: opts.environment,
          connectionId: ctx.connectionId,
          entities: t.entities,
          columns: t.columns,
          defaults: { maxReadRows: maxRows },
        });
        return read.effect === 'ALLOW'
          ? { effect: 'ALLOW', maxRows: read.limits.maxReadRows }
          : { effect: 'DENY', reason: 'The change was denied by policy' };
      },
    });
    if (out.truncated) {
      throw refuse(
        'PREVIEW',
        new AppError(
          'WRITE_ROW_LIMIT_EXCEEDED',
          `The change affects more than ${out.maxRows} rows.`,
          { maxWriteRows: out.maxRows },
        ),
      );
    }
    const index = out.columns.map((c) => c.toUpperCase());
    return out.rows.map((raw) => {
      const before: RecordValues = {};
      selected.forEach((name) => {
        const i = index.indexOf(name);
        before[name] = i === -1 ? null : toValue(raw[i]);
      });
      const key: RecordValues = {};
      for (const k of pk) key[k] = before[k] ?? null;
      const after: RecordValues = { ...before };
      stmt.set.forEach((s, i) => {
        after[setColumns[i]!] = simulate(s.value, before, qualifiers);
      });
      return { key, before, after };
    });
  }

  private async auditRefusal(
    ctx: PrepareContext,
    classified: Classified | undefined,
    environment: Environment | null,
    err: unknown,
  ): Promise<void> {
    const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
    const denied = err instanceof Refusal || code === 'FORBIDDEN' || code === 'SQL_FORBIDDEN';
    const write =
      classified && classified.kind !== 'UNKNOWN' && classified.kind !== 'SELECT'
        ? classified
        : undefined;
    await this.deps.audit.record({
      userId: ctx.auth.user.id,
      userEmail: ctx.auth.user.email,
      ip: ctx.meta?.ip ?? null,
      requestId: ctx.meta?.requestId ?? null,
      action: denied ? 'write.denied' : 'write.preview_failed',
      status: denied ? 'denied' : 'failed',
      operation: write?.kind ?? null,
      resource: write?.table ?? null,
      statement: ctx.sql,
      connectionId: ctx.connectionId,
      environment,
      errorCode: code,
      errorMessage: err instanceof Error ? err.message : String(err),
      details: {
        connectionId: ctx.connectionId,
        stage: err instanceof Refusal ? err.stage : 'PREVIEW',
        preview: true,
        ...(err instanceof Refusal ? err.internal : {}),
      },
    });
  }
}

function policySummary(d: PolicyDecision): Record<string, unknown> {
  return {
    effect: d.effect,
    policyVersion: d.policyVersion,
    matchedRuleIds: d.matchedRuleIds,
    limits: d.limits,
  };
}

function catalogTable(catalog: Catalog, name: string): CatalogTable {
  const t = catalog.tables.find((x) => x.name.toUpperCase() === name.toUpperCase());
  if (!t)
    throw refuse(
      'VALIDATE',
      new AppError('RESOURCE_NOT_FOUND', `Table ${name} is not in the catalog of this connection`),
    );
  return t;
}

function columnOf(name: string, known: Set<string>): string {
  const upper = name.toUpperCase();
  if (!IDENT.test(name) || !known.has(upper)) {
    throw refuse(
      'VALIDATE',
      new AppError('COLUMN_NOT_FOUND', `Unknown column "${name}".`, { column: name }),
    );
  }
  return upper;
}

function checkQualifier(table: string | undefined, qualifiers: Set<string>): void {
  if (table !== undefined && !qualifiers.has(table.toUpperCase())) {
    throw refuse(
      'VALIDATE',
      new AppError('COLUMN_NOT_FOUND', `Unknown table or alias "${table}".`),
    );
  }
}

/** Every column the write names (SET / INSERT columns and WHERE columns), for the policy check. */
function writeColumns(
  stmt: InsertStatement | UpdateStatement,
  table: CatalogTable,
): PolicyColumn[] {
  const entity = table.name.toUpperCase();
  const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
  const names = new Set<string>();
  if (stmt.type === 'insert') {
    for (const c of stmt.columns) names.add(columnOf(c, known));
  } else {
    const qualifiers = new Set([entity]);
    if (stmt.table.alias) qualifiers.add(stmt.table.alias.toUpperCase());
    for (const s of stmt.set) {
      names.add(columnOf(s.column, known));
      collectColumns(s.value, qualifiers, known, names);
    }
    if (stmt.where) collectColumns(stmt.where, qualifiers, known, names);
  }
  return [...names].map((name) => ({ table: entity, name }));
}

function collectColumns(
  e: Expr,
  qualifiers: Set<string>,
  known: Set<string>,
  out: Set<string>,
): void {
  switch (e.kind) {
    case 'literal':
      return;
    case 'column':
      checkQualifier(e.table, qualifiers);
      out.add(columnOf(e.name, known));
      return;
    case 'compare':
    case 'arith':
    case 'and':
    case 'or':
      collectColumns(e.left, qualifiers, known, out);
      collectColumns(e.right, qualifiers, known, out);
      return;
    case 'not':
    case 'neg':
    case 'isNull':
      collectColumns(e.expr, qualifiers, known, out);
      return;
    case 'in':
      collectColumns(e.expr, qualifiers, known, out);
      for (const x of e.list) collectColumns(x, qualifiers, known, out);
      return;
    case 'between':
      collectColumns(e.expr, qualifiers, known, out);
      collectColumns(e.low, qualifiers, known, out);
      collectColumns(e.high, qualifiers, known, out);
      return;
    case 'like':
      collectColumns(e.expr, qualifiers, known, out);
      collectColumns(e.pattern, qualifiers, known, out);
      return;
    case 'aggregate':
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'Aggregates are not allowed in a write.'),
      );
  }
}

function literalSql(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v))
      throw refuse('VALIDATE', new AppError('SQL_UNSUPPORTED', 'Invalid numeric literal.'));
    return String(v);
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw refuse(
    'VALIDATE',
    new AppError('SQL_UNSUPPORTED', 'Boolean literals are not supported by the gateway dialects.'),
  );
}

/**
 * Renders the engine AST of a WHERE clause back to SQL for the before-snapshot SELECT. Only the
 * shapes the engine AST holds are rendered; columns are checked against the catalog and emitted
 * unqualified (the snapshot reads one table). The result still goes through the read gate.
 */
export function renderExpr(e: Expr, qualifiers: Set<string>, known: Set<string>): string {
  const r = (x: Expr) => renderExpr(x, qualifiers, known);
  switch (e.kind) {
    case 'literal':
      return literalSql(e.value);
    case 'column':
      checkQualifier(e.table, qualifiers);
      return columnOf(e.name, known);
    case 'compare':
    case 'arith':
      return `(${r(e.left)} ${e.op} ${r(e.right)})`;
    case 'and':
      return `(${r(e.left)} AND ${r(e.right)})`;
    case 'or':
      return `(${r(e.left)} OR ${r(e.right)})`;
    case 'not':
      return `(NOT ${r(e.expr)})`;
    case 'neg':
      return `(-${r(e.expr)})`;
    case 'in':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} IN (${e.list.map(r).join(', ')}))`;
    case 'between':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} BETWEEN ${r(e.low)} AND ${r(e.high)})`;
    case 'like':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} LIKE ${r(e.pattern)}${
        e.escape !== undefined ? ` ESCAPE ${literalSql(e.escape)}` : ''
      })`;
    case 'isNull':
      return `(${r(e.expr)} IS${e.negated ? ' NOT' : ''} NULL)`;
    case 'aggregate':
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'Aggregates are not allowed in a write.'),
      );
  }
}

/** True when a column-free (constant) condition, or a column compared with itself, makes the WHERE match every row. */
function hasColumn(e: Expr): boolean {
  switch (e.kind) {
    case 'literal':
      return false;
    case 'column':
      return true;
    case 'compare':
    case 'arith':
    case 'and':
    case 'or':
      return hasColumn(e.left) || hasColumn(e.right);
    case 'not':
    case 'neg':
    case 'isNull':
      return hasColumn(e.expr);
    case 'in':
      return hasColumn(e.expr) || e.list.some(hasColumn);
    case 'between':
      return hasColumn(e.expr) || hasColumn(e.low) || hasColumn(e.high);
    case 'like':
      return hasColumn(e.expr) || hasColumn(e.pattern);
    case 'aggregate':
      return true;
  }
}

function isTrivialWhere(e: Expr): boolean {
  if (!hasColumn(e)) return true;
  if (e.kind === 'and') return isTrivialWhere(e.left) && isTrivialWhere(e.right);
  if (e.kind === 'or') return isTrivialWhere(e.left) || isTrivialWhere(e.right);
  if (e.kind === 'compare' && e.op === '=' && e.left.kind === 'column' && e.right.kind === 'column') {
    return (
      e.left.name.toUpperCase() === e.right.name.toUpperCase() &&
      (e.left.table ?? '').toUpperCase() === (e.right.table ?? '').toUpperCase()
    );
  }
  return false;
}

const notSimulable = () =>
  refuse(
    'PREVIEW',
    new AppError(
      'OPERATION_NOT_SUPPORTED',
      'The new value cannot be simulated: use literals, columns and + - * /.',
    ),
  );

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** A number, or a decimal string as gateways return NUMBER columns; anything else is refused. */
function numeric(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMERIC.test(v.trim())) return Number(v);
  throw notSimulable();
}

/** Simulated after value of a SET expression for one before row. */
function simulate(e: Expr, row: RecordValues | null, qualifiers: Set<string>): Value {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'column':
      // INSERT values have no row to read from.
      if (row === null) throw notSimulable();
      checkQualifier(e.table, qualifiers);
      return row[e.name.toUpperCase()] ?? null;
    case 'neg': {
      const v = simulate(e.expr, row, qualifiers);
      return v === null ? null : -numeric(v);
    }
    case 'arith': {
      const a = simulate(e.left, row, qualifiers);
      const b = simulate(e.right, row, qualifiers);
      if (a === null || b === null) return null;
      const [x, y] = [numeric(a), numeric(b)];
      if (e.op === '+') return x + y;
      if (e.op === '-') return x - y;
      if (e.op === '*') return x * y;
      return y === 0 ? null : x / y;
    }
    default:
      throw notSimulable();
  }
}

function insertTarget(stmt: InsertStatement, table: CatalogTable): PreviewTarget {
  const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
  if (stmt.columns.length === 0 || stmt.columns.length !== stmt.values.length) {
    throw refuse(
      'VALIDATE',
      new AppError('OPERATION_NOT_SUPPORTED', 'INSERT must list its columns and one value each.'),
    );
  }
  const after: RecordValues = {};
  stmt.columns.forEach((c, i) => {
    after[columnOf(c, known)] = simulate(stmt.values[i]!, null, new Set());
  });
  const key: RecordValues = {};
  for (const c of table.columns) {
    const name = c.name.toUpperCase();
    if (c.pk && name in after) key[name] = after[name] ?? null;
  }
  return { key, before: null, after };
}

/** Gateway values to JSON-safe scalars. */
function toValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}
