/**
 * Local SELECT evaluation over in-memory sources: from/join → where →
 * group/aggregate → having → projection → order → distinct → offset/limit.
 *
 * Nothing here talks to a remote system; callers hand over the rows of every
 * table the statement references.
 */
import { AppError } from '@dbx/shared';
import type { AggregateFn, Expr, SelectItem, SelectStatement, TableRef } from '../ast';
import { conjuncts, containsAggregate, exprToSql, walkColumns } from '../ast';
import type { Accumulator, ColumnType, ScopeColumn } from '../eval';
import {
  Scope,
  compile,
  compilePredicate,
  createAccumulator,
  exprKey,
  inferType,
  orderValues,
  suggest,
  toNumber,
} from '../eval';
import type { Row, Value } from '../values';

export interface LocalColumn {
  name: string;
  type?: ColumnType;
}

/** One table available to the evaluator: column names plus positional rows. */
export interface LocalSource {
  columns: LocalColumn[];
  rows: Row[];
}

export interface LocalLimits {
  /** Max rows returned (implicit LIMIT); an explicit LIMIT above it is rejected. */
  maxRows: number;
  /** Max rows held in memory while evaluating (sources and join output). */
  maxMaterializedRows: number;
}

export const DEFAULT_LOCAL_LIMITS: LocalLimits = { maxRows: 1000, maxMaterializedRows: 50_000 };

export interface ResultColumn {
  name: string;
  type: ScopeColumn['type'];
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Row[];
  rowCount: number;
  truncated: boolean;
  messages: string[];
}

interface BoundTable {
  alias: string;
  source: LocalSource;
  offset: number;
  join?: { type: 'INNER' | 'LEFT'; on: Expr };
}

// ---------------------------------------------------------------- binding

function resolveSource(
  sources: Record<string, LocalSource>,
  name: string,
): { name: string; source: LocalSource } {
  if (Object.hasOwn(sources, name)) return { name, source: sources[name] as LocalSource };
  const lower = name.toLowerCase();
  const found = Object.keys(sources).find((k) => k.toLowerCase() === lower);
  if (found !== undefined) return { name: found, source: sources[found] as LocalSource };
  const hint = suggest(name, Object.keys(sources));
  throw new AppError(
    'RESOURCE_NOT_FOUND',
    `Unknown table "${name}".${hint ? ` Did you mean "${hint}"?` : ''}`,
    { table: name, ...(hint ? { suggestion: hint } : {}) },
  );
}

function bindTables(stmt: SelectStatement, sources: Record<string, LocalSource>): BoundTable[] {
  if (!stmt.from) return [];
  const refs: Array<{ ref: TableRef; join?: BoundTable['join'] }> = [
    { ref: stmt.from },
    ...stmt.joins.map((j) => ({ ref: j.table, join: { type: j.type, on: j.on } })),
  ];
  const tables: BoundTable[] = [];
  const aliases = new Set<string>();
  let offset = 0;
  for (const { ref, join } of refs) {
    const { name, source } = resolveSource(sources, ref.name);
    const alias = ref.alias ?? name;
    if (aliases.has(alias)) {
      throw new AppError(
        'SQL_UNSUPPORTED',
        `Table alias "${alias}" is used twice; give each table a distinct alias.`,
      );
    }
    aliases.add(alias);
    tables.push({ alias, source, offset, ...(join ? { join } : {}) });
    offset += source.columns.length;
  }
  return tables;
}

function scopeColumns(table: BoundTable): ScopeColumn[] {
  return table.source.columns.map((c) => ({
    table: table.alias,
    name: c.name,
    type: c.type ?? 'unknown',
  }));
}

function isGrouped(stmt: SelectStatement): boolean {
  if (stmt.groupBy.length > 0 || stmt.having) return true;
  const exprs = [
    ...stmt.columns.flatMap((c) => (c.kind === 'expr' ? [c.expr] : [])),
    ...stmt.orderBy.flatMap((o) => (o.expr.kind === 'position' ? [] : [o.expr as Expr])),
  ];
  return exprs.some(containsAggregate);
}

function tablesOf(expr: Expr, scope: Scope): Set<string> {
  const out = new Set<string>();
  walkColumns(expr, (c) => out.add(scope.columns[scope.resolve(c)]?.table ?? ''));
  return out;
}

// ---------------------------------------------------------------- joins

function hashKey(v: Value): string | null {
  if (v === null) return null;
  const n = toNumber(v);
  return n !== null ? `n:${n}` : `s:${String(v)}`;
}

/**
 * Joins `left` with one more table. An equality conjunct between the new table
 * and the tables on the left is used as a hash key (a superset filter); the
 * full ON predicate is always evaluated on the candidates.
 */
function joinTable(table: BoundTable, joinScope: Scope, left: Row[], limits: LocalLimits): Row[] {
  const join = table.join as NonNullable<BoundTable['join']>;
  const width = table.source.columns.length;
  const on = compilePredicate(join.on, joinScope);

  let leftKey: ((row: Row) => Value) | undefined;
  let rightKey: ((row: Row) => Value) | undefined;
  for (const c of conjuncts(join.on)) {
    if (c.kind !== 'compare' || c.op !== '=') continue;
    const l = tablesOf(c.left, joinScope);
    const r = tablesOf(c.right, joinScope);
    const onlyRight = (s: Set<string>) => s.size === 1 && s.has(table.alias);
    const noRight = (s: Set<string>) => s.size > 0 && !s.has(table.alias);
    const [leftExpr, rightExpr] =
      noRight(l) && onlyRight(r)
        ? [c.left, c.right]
        : onlyRight(l) && noRight(r)
          ? [c.right, c.left]
          : [undefined, undefined];
    if (!leftExpr || !rightExpr) continue;
    const lf = compile(leftExpr, joinScope);
    const rf = compile(rightExpr, joinScope);
    const pad: Row = new Array<Value>(table.offset).fill(null);
    leftKey = lf;
    rightKey = (row) => rf([...pad, ...row]);
    break;
  }

  let candidates: (l: Row) => Row[];
  if (leftKey && rightKey) {
    const hash = new Map<string, Row[]>();
    for (const r of table.source.rows) {
      const hk = hashKey(rightKey(r));
      if (hk === null) continue;
      const bucket = hash.get(hk);
      if (bucket) bucket.push(r);
      else hash.set(hk, [r]);
    }
    const lk = leftKey;
    candidates = (l) => {
      const hk = hashKey(lk(l));
      return hk === null ? [] : (hash.get(hk) ?? []);
    };
  } else {
    if (left.length * table.source.rows.length > limits.maxMaterializedRows * 20) {
      throw new AppError(
        'JOIN_CARDINALITY_LIMIT',
        `JOIN ${table.alias} has no equality condition and would compare too many row pairs. Add an equality to the ON clause or filter the inputs.`,
      );
    }
    candidates = () => table.source.rows;
  }

  const nulls: Row = new Array<Value>(width).fill(null);
  const out: Row[] = [];
  for (const l of left) {
    let matched = false;
    for (const r of candidates(l)) {
      const combined = [...l, ...r];
      if (on(combined)) {
        out.push(combined);
        matched = true;
      }
    }
    if (!matched && join.type === 'LEFT') out.push([...l, ...nulls]);
    if (out.length > limits.maxMaterializedRows) {
      throw new AppError(
        'JOIN_CARDINALITY_LIMIT',
        `JOIN ${table.alias} produces more than ${limits.maxMaterializedRows} rows.`,
      );
    }
  }
  return out;
}

// ---------------------------------------------------------------- helpers

function walkExpr(e: Expr, fn: (x: Expr) => void): void {
  fn(e);
  switch (e.kind) {
    case 'literal':
    case 'column':
      return;
    case 'aggregate':
      if (e.arg !== '*') walkExpr(e.arg, fn);
      return;
    case 'not':
    case 'neg':
    case 'isNull':
      walkExpr(e.expr, fn);
      return;
    case 'in':
      walkExpr(e.expr, fn);
      e.list.forEach((x) => walkExpr(x, fn));
      return;
    case 'between':
      walkExpr(e.expr, fn);
      walkExpr(e.low, fn);
      walkExpr(e.high, fn);
      return;
    case 'like':
      walkExpr(e.expr, fn);
      walkExpr(e.pattern, fn);
      return;
    default:
      walkExpr(e.left, fn);
      walkExpr(e.right, fn);
  }
}

interface OutputItem {
  name: string;
  type: ScopeColumn['type'];
  fn: (row: Row) => Value;
  expr?: Expr;
  alias?: string;
}

function expandItems(
  items: SelectItem[],
  scope: Scope,
  compileExpr: (e: Expr) => (row: Row) => Value,
  grouped: boolean,
): OutputItem[] {
  const out: OutputItem[] = [];
  for (const item of items) {
    if (item.kind === 'star') {
      if (grouped)
        throw new AppError(
          'SQL_UNSUPPORTED',
          'SELECT * cannot be combined with GROUP BY or aggregate functions.',
        );
      const cols = scope.columns
        .map((c, i) => ({ c, i }))
        .filter(({ c }) => item.table === undefined || c.table === item.table);
      if (item.table !== undefined && cols.length === 0) {
        throw new AppError(
          'COLUMN_NOT_FOUND',
          `Unknown table or alias "${item.table}" in ${item.table}.*.`,
        );
      }
      for (const { c, i } of cols)
        out.push({ name: c.name, type: c.type, fn: (row) => row[i] ?? null });
      continue;
    }
    const name =
      item.alias ??
      (item.expr.kind === 'column' ? item.expr.name : item.text || exprToSql(item.expr));
    out.push({
      name,
      type: inferType(item.expr, scope),
      fn: compileExpr(item.expr),
      expr: item.expr,
      ...(item.alias ? { alias: item.alias } : {}),
    });
  }
  return out;
}

function collectAggregates(e: Expr, into: Array<Extract<Expr, { kind: 'aggregate' }>>): void {
  walkExpr(e, (x) => {
    if (x.kind === 'aggregate') {
      if (x.arg !== '*') {
        let nested = false;
        walkExpr(x.arg, (y) => (nested ||= y.kind === 'aggregate'));
        if (nested)
          throw new AppError('SQL_UNSUPPORTED', 'Nested aggregate functions are not supported.');
      }
      into.push(x);
    }
  });
}

function valueKey(values: Value[]): string {
  return JSON.stringify(values.map((v) => (v === null ? null : [typeof v, v])));
}

/** GROUP BY / HAVING may reference select aliases. */
function resolveAlias(e: Expr, items: SelectItem[]): Expr {
  if (e.kind === 'column' && e.table === undefined) {
    const item = items.find((it) => it.kind === 'expr' && it.alias === e.name);
    if (item && item.kind === 'expr') return item.expr;
  }
  return e;
}

function resolveAliasDeep(e: Expr, items: SelectItem[]): Expr {
  const aliased = new Map<string, Expr>();
  for (const it of items) if (it.kind === 'expr' && it.alias) aliased.set(it.alias, it.expr);
  if (aliased.size === 0) return e;
  const map = (x: Expr): Expr => {
    switch (x.kind) {
      case 'column':
        return x.table === undefined && aliased.has(x.name) ? (aliased.get(x.name) as Expr) : x;
      case 'literal':
      case 'aggregate':
        return x;
      case 'not':
      case 'neg':
      case 'isNull':
        return { ...x, expr: map(x.expr) };
      case 'in':
        return { ...x, expr: map(x.expr), list: x.list.map(map) };
      case 'between':
        return { ...x, expr: map(x.expr), low: map(x.low), high: map(x.high) };
      case 'like':
        return { ...x, expr: map(x.expr), pattern: map(x.pattern) };
      default:
        return { ...x, left: map(x.left), right: map(x.right) };
    }
  };
  return map(e);
}

// ---------------------------------------------------------------- main

/** Evaluates a SELECT over in-memory sources keyed by table name (case-insensitive). */
export function evaluateSelect(
  stmt: SelectStatement,
  sources: Record<string, LocalSource>,
  limits: LocalLimits = DEFAULT_LOCAL_LIMITS,
): QueryResult {
  const tables = bindTables(stmt, sources);
  const scope = new Scope(tables.flatMap(scopeColumns));

  if (stmt.limit !== undefined && stmt.limit > limits.maxRows) {
    throw new AppError(
      'QUERY_ROW_LIMIT_EXCEEDED',
      `LIMIT ${stmt.limit} exceeds the maximum of ${limits.maxRows} rows per query.`,
      { maxRows: limits.maxRows },
    );
  }
  const implicitLimit = stmt.limit === undefined;
  const limit = stmt.limit ?? limits.maxRows;
  const offset = stmt.offset ?? 0;
  const grouped = isGrouped(stmt);
  for (const e of conjuncts(stmt.where)) {
    if (containsAggregate(e))
      throw new AppError(
        'SQL_UNSUPPORTED',
        'Aggregate functions are not allowed in WHERE; use HAVING.',
      );
  }
  const whereFn = stmt.where ? compilePredicate(stmt.where, scope) : undefined;
  const messages: string[] = [];

  // 1) Sources and joins (or a single empty row for SELECT without FROM).
  for (const t of tables) {
    if (t.source.rows.length > limits.maxMaterializedRows) {
      throw new AppError(
        'QUERY_LIMIT_EXCEEDED',
        `Table ${t.alias} has more than ${limits.maxMaterializedRows} rows; filter it before evaluating locally.`,
        { maxMaterializedRows: limits.maxMaterializedRows },
      );
    }
  }
  let rows: Row[] = tables[0] ? tables[0].source.rows.map((r) => [...r]) : [[]];
  for (let i = 1; i < tables.length; i++) {
    const t = tables[i] as BoundTable;
    const joinScope = new Scope(scope.columns.slice(0, t.offset + t.source.columns.length));
    rows = joinTable(t, joinScope, rows, limits);
  }

  // 2) WHERE.
  if (whereFn) rows = rows.filter(whereFn);

  // 3) Grouping / aggregation.
  let compileOpts: Parameters<typeof compile>[2] = {};
  if (grouped) {
    const selectExprs = stmt.columns.flatMap((c) => (c.kind === 'expr' ? [c.expr] : []));
    const groupExprs = stmt.groupBy.map((g) => {
      if ('index' in g && g.kind === 'position') {
        const item = stmt.columns[g.index - 1];
        if (!item || item.kind !== 'expr')
          throw new AppError(
            'SQL_UNSUPPORTED',
            `GROUP BY position ${g.index} is not a select expression.`,
          );
        return item.expr;
      }
      return resolveAlias(g as Expr, stmt.columns);
    });
    for (const g of groupExprs) {
      const aggs: Array<Extract<Expr, { kind: 'aggregate' }>> = [];
      collectAggregates(g, aggs);
      if (aggs.length > 0)
        throw new AppError('SQL_UNSUPPORTED', 'Aggregate functions are not allowed in GROUP BY.');
    }
    const aggs: Array<Extract<Expr, { kind: 'aggregate' }>> = [];
    for (const e of selectExprs) collectAggregates(e, aggs);
    if (stmt.having) collectAggregates(stmt.having, aggs);
    for (const o of stmt.orderBy)
      if (o.expr.kind !== 'position') collectAggregates(o.expr as Expr, aggs);

    const layout = new Map<string, number>();
    const keyFns: Array<(row: Row) => Value> = [];
    for (const g of groupExprs) {
      const k = exprKey(g, scope);
      if (layout.has(k)) continue;
      layout.set(k, keyFns.length);
      keyFns.push(compile(g, scope));
    }
    const aggSpecs: Array<{
      fn: AggregateFn;
      distinct: boolean;
      star: boolean;
      arg?: (row: Row) => Value;
    }> = [];
    for (const a of aggs) {
      const k = exprKey(a, scope);
      if (layout.has(k)) continue;
      layout.set(k, keyFns.length + aggSpecs.length);
      aggSpecs.push({
        fn: a.fn,
        distinct: a.distinct,
        star: a.arg === '*',
        ...(a.arg === '*' ? {} : { arg: compile(a.arg, scope) }),
      });
    }
    const groups = new Map<string, { keys: Value[]; accs: Accumulator[] }>();
    for (const row of rows) {
      const keys = keyFns.map((f) => f(row));
      const gk = valueKey(keys);
      let g = groups.get(gk);
      if (!g) {
        g = { keys, accs: aggSpecs.map((s) => createAccumulator(s.fn, s.distinct, s.star)) };
        groups.set(gk, g);
      }
      g.accs.forEach((acc, i) => {
        const arg = aggSpecs[i]?.arg;
        acc.add(arg ? arg(row) : 1);
      });
    }
    if (groups.size === 0 && groupExprs.length === 0) {
      groups.set('', {
        keys: [],
        accs: aggSpecs.map((s) => createAccumulator(s.fn, s.distinct, s.star)),
      });
    }
    rows = [...groups.values()].map((g) => [...g.keys, ...g.accs.map((a) => a.result())]);
    compileOpts = { grouped: layout };
    if (stmt.having) {
      const having = compilePredicate(
        resolveAliasDeep(stmt.having, stmt.columns),
        scope,
        compileOpts,
      );
      rows = rows.filter(having);
    }
  }

  // 4) Projection (kept alongside the source row for ORDER BY on non-projected columns).
  const items = expandItems(stmt.columns, scope, (e) => compile(e, scope, compileOpts), grouped);
  let pairs = rows.map((src) => ({ src, out: items.map((it) => it.fn(src)) }));

  // 5) ORDER BY.
  if (stmt.orderBy.length > 0) {
    const keyFns = stmt.orderBy.map((o) => {
      const e = o.expr;
      if (e.kind === 'position') {
        const idx = (e as { index: number }).index - 1;
        if (idx < 0 || idx >= items.length)
          throw new AppError('SQL_UNSUPPORTED', `ORDER BY position ${idx + 1} is out of range.`);
        return { desc: o.desc, fn: (p: { out: Row }) => p.out[idx] ?? null };
      }
      const expr = e as Expr;
      if (expr.kind === 'column' && expr.table === undefined) {
        const idx = items.findIndex((it) => it.alias === expr.name);
        if (idx >= 0) return { desc: o.desc, fn: (p: { out: Row }) => p.out[idx] ?? null };
      }
      const f = compile(expr, scope, compileOpts);
      return { desc: o.desc, fn: (p: { src: Row }) => f(p.src) };
    });
    pairs = pairs
      .map((p, i) => ({ p, i, keys: keyFns.map((k) => k.fn(p)) }))
      .sort((a, b) => {
        for (let k = 0; k < keyFns.length; k++) {
          const c = orderValues(a.keys[k] ?? null, b.keys[k] ?? null);
          if (c !== 0) return keyFns[k]?.desc ? -c : c;
        }
        return a.i - b.i;
      })
      .map((x) => x.p);
  }

  // 6) DISTINCT.
  let out = pairs.map((p) => p.out);
  if (stmt.distinct) {
    const seen = new Set<string>();
    out = out.filter((r) => {
      const k = valueKey(r);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // 7) OFFSET / LIMIT.
  const afterOffset = out.slice(offset);
  const truncated = implicitLimit && afterOffset.length > limit;
  const finalRows = afterOffset.slice(0, limit);
  if (truncated) {
    messages.push(
      `Result truncated to ${limit} rows. Add filters or an explicit LIMIT/OFFSET to page through the data.`,
    );
  }

  return {
    columns: items.map((it) => ({ name: it.name, type: it.type })),
    rows: finalRows,
    rowCount: finalRows.length,
    truncated,
    messages,
  };
}
