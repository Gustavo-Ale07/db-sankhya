/**
 * Expression binding and evaluation. Expressions are compiled once into closures
 * over a row (array of values) using SQL three-valued logic: `null` is UNKNOWN.
 */
import { AppError } from '@dbx/shared';
import type { AggregateFn, Expr } from './ast';
import { exprToSql } from './ast';
import type { Row, Value } from './values';

/** Declared type of a column, when known. */
export type ColumnType = 'integer' | 'number' | 'string' | 'date' | 'flag';

export interface ScopeColumn {
  /** Table alias (or name) the column belongs to; '' for computed columns. */
  table: string;
  name: string;
  type: ColumnType | 'unknown';
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] as number;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j] as number;
      dp[j] = Math.min(
        (dp[j] as number) + 1,
        (dp[j - 1] as number) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[b.length] as number;
}

export function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestScore = Infinity;
  const lower = name.toLowerCase();
  for (const c of candidates) {
    const score =
      c.toLowerCase().startsWith(lower) && lower.length >= 3
        ? 1
        : levenshtein(lower, c.toLowerCase());
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(name.length / 3))
    ? best
    : undefined;
}

export class Scope {
  constructor(readonly columns: ScopeColumn[]) {}

  resolve(ref: { table?: string; name: string }): number {
    if (ref.table !== undefined) {
      const tables = new Set(this.columns.map((c) => c.table));
      if (!tables.has(ref.table)) {
        const hint = suggest(ref.table, tables);
        throw new AppError(
          'COLUMN_NOT_FOUND',
          `Unknown table or alias "${ref.table}".${hint ? ` Did you mean "${hint}"?` : ''}`,
        );
      }
    }
    const matches: number[] = [];
    this.columns.forEach((c, i) => {
      if (c.name === ref.name && (ref.table === undefined || c.table === ref.table))
        matches.push(i);
    });
    if (matches.length === 1) return matches[0] as number;
    const label = ref.table ? `${ref.table}.${ref.name}` : ref.name;
    if (matches.length > 1) {
      throw new AppError(
        'AMBIGUOUS_COLUMN',
        `Column "${label}" is ambiguous; qualify it with the table alias.`,
      );
    }
    const pool = this.columns
      .filter((c) => ref.table === undefined || c.table === ref.table)
      .map((c) => c.name);
    const hint = suggest(ref.name, pool);
    throw new AppError(
      'COLUMN_NOT_FOUND',
      `Unknown column "${label}".${hint ? ` Did you mean "${hint}"?` : ''}`,
      {
        column: label,
        ...(hint ? { suggestion: hint } : {}),
      },
    );
  }
}

// ---------------------------------------------------------------- value semantics

export function toNumber(v: Value): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null;
    return Number(t);
  }
  return null;
}

/** Comparison result (<0, 0, >0) or null when either side is NULL. */
export function compareValues(a: Value, b: Value): number | null {
  if (a === null || b === null) return null;
  if (
    typeof a === 'number' ||
    typeof b === 'number' ||
    typeof a === 'boolean' ||
    typeof b === 'boolean'
  ) {
    const x = toNumber(a);
    const y = toNumber(b);
    if (x !== null && y !== null) return x === y ? 0 : x < y ? -1 : 1;
  }
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

/** Removes binary floating-point noise from money arithmetic (0.1 + 0.2, long SUMs). */
export function cleanFloat(n: number): number {
  return Number.isFinite(n) ? Number.parseFloat(n.toPrecision(15)) : n;
}

const collator = new Intl.Collator('pt-BR', { numeric: true, sensitivity: 'base' });

/** Ordering for ORDER BY: NULLs first, numbers numerically, text with pt-BR collation. */
export function orderValues(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const x = toNumber(a);
  const y = toNumber(b);
  if (x !== null && y !== null && (typeof a === 'number' || typeof b === 'number')) return x - y;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return collator.compare(String(a), String(b));
}

type LikeToken = { kind: 'char'; ch: string } | { kind: 'one' } | { kind: 'many' };

const sameChar = (a: string, b: string) =>
  a === b || a.toLowerCase() === b.toLowerCase() || a.toUpperCase() === b.toUpperCase();

/**
 * Compiles a LIKE pattern (case-insensitive, `%` and `_`, optional ESCAPE) into a matcher.
 *
 * Deliberately not a RegExp: patterns such as `%a%a%a…b` make backtracking regex engines take
 * exponential time on the synchronous event loop. This greedy wildcard matcher only backtracks to
 * the last `%`, so it runs in O(pattern × text) at worst.
 */
export function compileLike(pattern: string, escape?: string): (text: string) => boolean {
  const chars = Array.from(pattern);
  const tokens: LikeToken[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (escape !== undefined && ch === escape && i + 1 < chars.length) {
      tokens.push({ kind: 'char', ch: chars[++i] as string });
    } else if (ch === '%') {
      if (tokens.at(-1)?.kind !== 'many') tokens.push({ kind: 'many' });
    } else if (ch === '_') tokens.push({ kind: 'one' });
    else tokens.push({ kind: 'char', ch });
  }
  return (input) => {
    const text = Array.from(input);
    let t = 0;
    let p = 0;
    let starP = -1;
    let starT = 0;
    while (t < text.length) {
      const tok = tokens[p];
      if (
        tok &&
        (tok.kind === 'one' || (tok.kind === 'char' && sameChar(tok.ch, text[t] as string)))
      ) {
        t++;
        p++;
      } else if (tok?.kind === 'many') {
        starP = p++;
        starT = t;
      } else if (starP >= 0) {
        p = starP + 1;
        t = ++starT;
      } else return false;
    }
    while (tokens[p]?.kind === 'many') p++;
    return p === tokens.length;
  };
}

type Fn = (row: Row) => Value;

export interface CompileOptions {
  /** Grouped mode: expression keys (see exprKey) → index in the grouped row. */
  grouped?: Map<string, number>;
}

/** Canonical key of an expression with column references resolved to positions. */
export function exprKey(expr: Expr, scope: Scope): string {
  return exprToSql(mapColumns(expr, (c) => ({ kind: 'column', name: `$${scope.resolve(c)}` })));
}

function mapColumns(expr: Expr, fn: (c: Extract<Expr, { kind: 'column' }>) => Expr): Expr {
  switch (expr.kind) {
    case 'column':
      return fn(expr);
    case 'literal':
      return expr;
    case 'aggregate':
      return expr.arg === '*' ? expr : { ...expr, arg: mapColumns(expr.arg, fn) };
    case 'not':
    case 'neg':
    case 'isNull':
      return { ...expr, expr: mapColumns(expr.expr, fn) };
    case 'in':
      return {
        ...expr,
        expr: mapColumns(expr.expr, fn),
        list: expr.list.map((e) => mapColumns(e, fn)),
      };
    case 'between':
      return {
        ...expr,
        expr: mapColumns(expr.expr, fn),
        low: mapColumns(expr.low, fn),
        high: mapColumns(expr.high, fn),
      };
    case 'like':
      return { ...expr, expr: mapColumns(expr.expr, fn), pattern: mapColumns(expr.pattern, fn) };
    default:
      return { ...expr, left: mapColumns(expr.left, fn), right: mapColumns(expr.right, fn) };
  }
}

const truth = (v: Value): boolean | null => {
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  const n = toNumber(v);
  return n === null ? false : n !== 0;
};

export function compile(expr: Expr, scope: Scope, opts: CompileOptions = {}): Fn {
  if (opts.grouped) {
    const key = exprKey(expr, scope);
    const idx = opts.grouped.get(key);
    if (idx !== undefined) return (row) => row[idx] ?? null;
  }
  switch (expr.kind) {
    case 'literal': {
      const v = expr.value;
      return () => v;
    }
    case 'column': {
      const idx = scope.resolve(expr);
      if (opts.grouped) {
        throw new AppError(
          'SQL_UNSUPPORTED',
          `Column "${exprToSql(expr)}" must appear in GROUP BY or be used inside an aggregate function.`,
        );
      }
      return (row) => row[idx] ?? null;
    }
    case 'aggregate':
      throw new AppError('SQL_UNSUPPORTED', `Aggregate ${exprToSql(expr)} is not allowed here.`);
    case 'and': {
      const l = compile(expr.left, scope, opts);
      const r = compile(expr.right, scope, opts);
      return (row) => {
        const a = truth(l(row));
        if (a === false) return false;
        const b = truth(r(row));
        if (b === false) return false;
        return a === null || b === null ? null : true;
      };
    }
    case 'or': {
      const l = compile(expr.left, scope, opts);
      const r = compile(expr.right, scope, opts);
      return (row) => {
        const a = truth(l(row));
        if (a === true) return true;
        const b = truth(r(row));
        if (b === true) return true;
        return a === null || b === null ? null : false;
      };
    }
    case 'not': {
      const inner = compile(expr.expr, scope, opts);
      return (row) => {
        const v = truth(inner(row));
        return v === null ? null : !v;
      };
    }
    case 'neg': {
      const inner = compile(expr.expr, scope, opts);
      return (row) => {
        const n = toNumber(inner(row));
        return n === null ? null : -n;
      };
    }
    case 'compare': {
      const l = compile(expr.left, scope, opts);
      const r = compile(expr.right, scope, opts);
      const op = expr.op;
      return (row) => {
        const c = compareValues(l(row), r(row));
        if (c === null) return null;
        switch (op) {
          case '=':
            return c === 0;
          case '<>':
            return c !== 0;
          case '>':
            return c > 0;
          case '>=':
            return c >= 0;
          case '<':
            return c < 0;
          case '<=':
            return c <= 0;
        }
      };
    }
    case 'arith': {
      const l = compile(expr.left, scope, opts);
      const r = compile(expr.right, scope, opts);
      const op = expr.op;
      return (row) => {
        const a = toNumber(l(row));
        const b = toNumber(r(row));
        if (a === null || b === null) return null;
        let out: number;
        if (op === '+') out = a + b;
        else if (op === '-') out = a - b;
        else if (op === '*') out = a * b;
        else {
          if (b === 0) return null;
          out = a / b;
        }
        return cleanFloat(out);
      };
    }
    case 'in': {
      const target = compile(expr.expr, scope, opts);
      const list = expr.list.map((e) => compile(e, scope, opts));
      const negated = expr.negated;
      return (row) => {
        const v = target(row);
        if (v === null) return null;
        let sawNull = false;
        for (const item of list) {
          const c = compareValues(v, item(row));
          if (c === 0) return !negated;
          if (c === null) sawNull = true;
        }
        return sawNull ? null : negated;
      };
    }
    case 'between': {
      const target = compile(expr.expr, scope, opts);
      const low = compile(expr.low, scope, opts);
      const high = compile(expr.high, scope, opts);
      const negated = expr.negated;
      return (row) => {
        const v = target(row);
        const a = compareValues(v, low(row));
        const b = compareValues(v, high(row));
        if (a === null || b === null) return null;
        const inside = a >= 0 && b <= 0;
        return negated ? !inside : inside;
      };
    }
    case 'like': {
      const target = compile(expr.expr, scope, opts);
      const negated = expr.negated;
      const escape = expr.escape;
      if (expr.pattern.kind === 'literal') {
        if (expr.pattern.value === null) return () => null;
        const matches = compileLike(String(expr.pattern.value), escape);
        return (row) => {
          const v = target(row);
          if (v === null) return null;
          const m = matches(String(v));
          return negated ? !m : m;
        };
      }
      const pattern = compile(expr.pattern, scope, opts);
      return (row) => {
        const v = target(row);
        const p = pattern(row);
        if (v === null || p === null) return null;
        const m = compileLike(String(p), escape)(String(v));
        return negated ? !m : m;
      };
    }
    case 'isNull': {
      const inner = compile(expr.expr, scope, opts);
      const negated = expr.negated;
      return (row) => (inner(row) === null) !== negated;
    }
  }
}

/** Compiles a predicate: only TRUE keeps a row. */
export function compilePredicate(
  expr: Expr,
  scope: Scope,
  opts: CompileOptions = {},
): (row: Row) => boolean {
  const fn = compile(expr, scope, opts);
  return (row) => truth(fn(row)) === true;
}

export function inferType(expr: Expr, scope: Scope): ScopeColumn['type'] {
  switch (expr.kind) {
    case 'column':
      return scope.columns[scope.resolve(expr)]?.type ?? 'unknown';
    case 'literal':
      return typeof expr.value === 'number'
        ? 'number'
        : typeof expr.value === 'string'
          ? 'string'
          : 'unknown';
    case 'arith':
    case 'neg':
      return 'number';
    case 'aggregate':
      if (expr.fn === 'COUNT') return 'integer';
      if (expr.fn === 'MIN' || expr.fn === 'MAX')
        return expr.arg === '*' ? 'unknown' : inferType(expr.arg, scope);
      return 'number';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------- aggregates

export interface Accumulator {
  add(v: Value): void;
  result(): Value;
}

export function createAccumulator(fn: AggregateFn, distinct: boolean, star: boolean): Accumulator {
  const seen = distinct ? new Set<string>() : undefined;
  const accept = (v: Value): boolean => {
    if (star) return true;
    if (v === null) return false;
    if (seen) {
      const key = `${typeof v}:${String(v)}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    return true;
  };
  switch (fn) {
    case 'COUNT': {
      let n = 0;
      return { add: (v) => void (accept(v) && n++), result: () => n };
    }
    case 'SUM':
    case 'AVG': {
      let sum = 0;
      let n = 0;
      return {
        add: (v) => {
          if (!accept(v)) return;
          const x = toNumber(v);
          if (x === null) return;
          sum += x;
          n++;
        },
        result: () => {
          if (n === 0) return null;
          return cleanFloat(fn === 'SUM' ? sum : sum / n);
        },
      };
    }
    case 'MIN':
    case 'MAX': {
      let best: Value = null;
      return {
        add: (v) => {
          if (!accept(v)) return;
          if (best === null) best = v;
          else {
            const c = orderValues(v, best);
            if ((fn === 'MIN' && c < 0) || (fn === 'MAX' && c > 0)) best = v;
          }
        },
        result: () => best,
      };
    }
  }
}
