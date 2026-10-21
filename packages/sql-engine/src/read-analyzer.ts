/**
 * AST allowlist for reads sent to Sankhya. Runs after the token gate: parses
 * the statement with the T-SQL grammar, walks every node and refuses any node
 * type, clause or function it does not explicitly know. Collects the tables,
 * columns, stars, functions and CTE names so the policy layer can check them
 * against the catalog.
 */
import { AppError } from '@dbx/shared';
import parserPkg from 'node-sql-parser';
import { isAllowedFunction } from './functions';
import { tokenize } from './tokenizer';

const { Parser } = parserPkg;
const parser = new Parser();

type Node = Record<string, unknown>;

export interface ReadAnalysis {
  tables: { name: string; alias?: string }[];
  columns: { table?: string; name: string }[];
  /**
   * Star references. `inAggregate` marks a star that is the direct argument of COUNT (`COUNT(*)`):
   * it counts rows and reads no column value, so the policy layer does not expand it.
   */
  star: { table?: string; inAggregate?: true }[];
  functions: string[];
  ctes: string[];
  /**
   * The outermost query has an ORDER BY (on any branch of its top-level set-operator chain,
   * where the grammar attaches a trailing ORDER BY). Nested ORDER BYs (subqueries, window
   * specifications) do not count.
   */
  orderBy: boolean;
  /**
   * Wrapping the statement as `SELECT * FROM (<sql>) …` keeps its result shape: on every
   * branch of the outer set-operator chain each select item is a column reference or carries
   * an alias, a star is the only item and is unqualified over a single FROM source, and no two
   * output names collide (case-insensitive). When false, the row cap must be applied by the
   * caller instead of by a wrapper.
   */
  rowCapSafe: boolean;
}

/**
 * SQL dialect of the Sankhya database the read will run on. It only changes
 * how CONVERT is read: T-SQL `CONVERT(type, expr[, style])` takes a data type
 * first, Oracle `CONVERT(expr, dest_charset[, source_charset])` takes only
 * expressions.
 */
export type ReadDialect = 'oracle' | 'mssql';

/**
 * Options for {@link analyzeRead}.
 *
 * - `dialect: 'mssql'`: the first CONVERT argument must be an allowlisted type
 *   name (`INT`, `VARCHAR(10)` …); any other first argument is refused.
 * - `dialect: 'oracle'`: every CONVERT argument is an ordinary expression, so
 *   columns in any position are collected and checked.
 * - `dialect` omitted: fail closed. CONVERT whose first argument is a bare
 *   identifier or a type-like call (`MONEY`, `VARCHAR(10)`) is refused, since
 *   it could be either a type or a column; any other first argument is walked
 *   as an expression.
 *
 * DATEADD / DATEDIFF keep the date-part allowlist in every dialect.
 */
export interface ReadAnalysisOptions {
  dialect?: ReadDialect;
}

const unsupported = (message: string): AppError => new AppError('SQL_UNSUPPORTED', message);

/** Nullish check (the AST uses both null and undefined for absent parts). */
function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const LITERAL_TYPES = new Set([
  'number',
  'single_quote_string',
  'var_string',
  'natural_string',
  'hex_string',
  'full_hex_string',
  'bit_string',
  'string',
  'bool',
  'boolean',
  'null',
  'date',
  'time',
  'timestamp',
  'datetime',
]);

const BINARY_OPERATORS = new Set([
  'AND',
  'OR',
  '=',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '||',
  'IN',
  'NOT IN',
  'BETWEEN',
  'NOT BETWEEN',
  'LIKE',
  'NOT LIKE',
  'IS',
  'IS NOT',
]);

const UNARY_OPERATORS = new Set(['-', '+', 'NOT', 'EXISTS', 'NOT EXISTS']);
const JOIN_KINDS = new Set([
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'FULL JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
]);
const SET_OPS = new Set(['union', 'union all', 'intersect', 'except']);
/** Zero-argument functions the grammar exposes as bare column references. */
const NILADIC = new Set(['SYSDATE', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'GETDATE']);
/** T-SQL date parts accepted as the first argument of DATEADD / DATEDIFF. */
const DATE_PARTS: ReadonlySet<string> = new Set(
  (
    'year yy yyyy quarter qq q month mm m dayofyear dy y day dd d week wk ww weekday dw ' +
    'hour hh minute mi n second ss s millisecond ms microsecond mcs nanosecond ns'
  )
    .toUpperCase()
    .split(' '),
);
/** Type names accepted as the first argument of CONVERT (sized forms take numbers only). */
const CONVERT_TYPES: ReadonlySet<string> = new Set(
  (
    'varchar nvarchar char nchar int bigint smallint tinyint decimal numeric float real ' +
    'date datetime datetime2 smalldatetime time bit money varbinary'
  )
    .toUpperCase()
    .split(' '),
);
/**
 * Functions whose first argument is a keyword (date part / data type), not a
 * column. Only the listed keywords are skipped; anything else is refused, so a
 * column can never hide in that position.
 */
const KEYWORD_FIRST_ARG: ReadonlyMap<string, { words: ReadonlySet<string>; sized: boolean }> =
  new Map([
    ['CONVERT', { words: CONVERT_TYPES, sized: true }],
    ['DATEADD', { words: DATE_PARTS, sized: false }],
    ['DATEDIFF', { words: DATE_PARTS, sized: false }],
  ]);

function columnText(column: unknown): string | undefined {
  if (typeof column === 'string') return column;
  if (isNode(column) && isNode(column.expr) && typeof column.expr.value === 'string') {
    return column.expr.value;
  }
  return undefined;
}

function functionName(node: Node): string {
  const name = node.name;
  if (typeof name === 'string') return name.toUpperCase();
  if (isNode(name) && Array.isArray(name.name)) {
    const parts = name.name.map((p: unknown) =>
      isNode(p) && typeof p.value === 'string' ? p.value : '',
    );
    if (parts.length !== 1 || parts[0] === '' || name.schema) {
      throw unsupported(`Qualified function ${parts.join('.')} is not allowed.`);
    }
    return (parts[0] as string).toUpperCase();
  }
  throw unsupported('Unrecognised function call.');
}

/**
 * True when `arg` is exactly an allowlisted keyword: a bare unqualified word
 * (`day`, `INT`) or, when `sized`, a sized type with numeric arguments only
 * (`VARCHAR(10)`, `DECIMAL(10, 2)`).
 */
function isKeywordArg(arg: unknown, words: ReadonlySet<string>, sized: boolean): boolean {
  if (!isNode(arg)) return false;
  if (arg.type === 'column_ref') {
    return (
      typeof arg.column === 'string' &&
      isNil(arg.table) &&
      isNil(arg.db) &&
      isNil(arg.schema) &&
      isNil(arg.collate) &&
      words.has(arg.column.toUpperCase())
    );
  }
  if (arg.type !== 'function' || !sized) return false;
  const name = arg.name;
  const parts = isNode(name) && Array.isArray(name.name) ? name.name : [];
  const part: unknown = parts.length === 1 ? parts[0] : undefined;
  const word = isNode(part) && part.type === 'default' ? part.value : undefined;
  if (typeof word !== 'string' || !words.has(word.toUpperCase())) return false;
  if (isNode(name) && !isNil(name.schema)) return false;
  if (!isNil(arg.over) || !isNil(arg.within_group)) return false;
  const args = arg.args;
  return (
    isNode(args) &&
    args.type === 'expr_list' &&
    Array.isArray(args.value) &&
    args.value.length > 0 &&
    args.value.every((v: unknown) => isNode(v) && v.type === 'number')
  );
}

class Walker {
  readonly tables: ReadAnalysis['tables'] = [];
  readonly columns: ReadAnalysis['columns'] = [];
  readonly star: ReadAnalysis['star'] = [];
  readonly functions = new Set<string>();
  readonly ctes: string[] = [];
  /** Every CTE name in the statement (upper-case), across all scopes. */
  private readonly cteKeys = new Set<string>();
  /** Every real table name referenced (upper-case), across all scopes. */
  private readonly realKeys = new Set<string>();
  /** Lexically visible CTE names, innermost WITH last. */
  private readonly scopes: Set<string>[] = [];

  constructor(private readonly dialect: ReadDialect | undefined) {}

  private isVisibleCte(name: string): boolean {
    const key = name.toUpperCase();
    return this.scopes.some((s) => s.has(key));
  }

  /**
   * Fail closed on CTE shadowing: a CTE may not share its name with any real
   * table referenced anywhere in the statement, so a real table can never be
   * mistaken for a CTE and dropped from `tables`.
   */
  assertNoShadowing(): void {
    for (const key of this.cteKeys) {
      if (this.realKeys.has(key)) {
        throw unsupported(`CTE name ${key} collides with a table read by the statement.`);
      }
    }
  }

  private useFunction(name: string): void {
    if (!isAllowedFunction(name)) throw unsupported(`Function ${name} is not allowed.`);
    this.functions.add(name);
  }

  /**
   * Walks a query expression. A WITH clause opens a scope covering the query
   * and the rest of its set-operator chain; each CTE name becomes visible only
   * after its own body was walked (later CTEs and the main query see it, its own
   * body and earlier bodies do not).
   */
  select(node: unknown, chained = false): void {
    if (!isNode(node) || node.type !== 'select') throw unsupported('Only SELECT is allowed.');
    if (Array.isArray(node.with)) {
      if (chained) throw unsupported('WITH is only allowed at the start of a query.');
      const scope = new Set<string>();
      this.scopes.push(scope);
      try {
        for (const cte of node.with) {
          if (!isNode(cte) || !isNode(cte.stmt)) throw unsupported('Unrecognised CTE.');
          const name = isNode(cte.name) ? cte.name.value : cte.name;
          if (typeof name !== 'string') throw unsupported('Unrecognised CTE name.');
          const key = name.toUpperCase();
          if (this.cteKeys.has(key)) throw unsupported(`CTE name ${name} is defined twice.`);
          this.select(cte.stmt.ast ?? cte.stmt);
          this.ctes.push(name);
          this.cteKeys.add(key);
          scope.add(key);
        }
        this.query(node);
      } finally {
        this.scopes.pop();
      }
    } else if (!isNil(node.with)) {
      throw unsupported('Unrecognised WITH clause.');
    } else {
      this.query(node);
    }
  }

  private query(node: Node): void {
    if (node.options) throw unsupported('SELECT options are not allowed.');
    if (node.for) throw unsupported('SELECT … FOR is not allowed.');
    if (isNode(node.into) && !isNil(node.into.position)) {
      throw unsupported('SELECT … INTO is not allowed.');
    }
    if (Array.isArray(node.columns)) {
      for (const col of node.columns) {
        if (!isNode(col)) throw unsupported('Unrecognised select item.');
        this.expr(col.expr);
      }
    } else if (node.columns === '*') {
      // Not produced by the parser today; recorded as a star so it can never read unchecked.
      this.star.push({});
    } else {
      throw unsupported('Unrecognised select list.');
    }
    if (Array.isArray(node.from)) for (const f of node.from) this.from(f);
    else if (!isNil(node.from)) throw unsupported('Unrecognised FROM clause.');
    this.expr(node.where);
    if (isNode(node.groupby)) this.exprs(node.groupby.columns);
    else if (Array.isArray(node.groupby)) this.exprs(node.groupby);
    else if (!isNil(node.groupby)) throw unsupported('Unrecognised GROUP BY.');
    this.expr(node.having);
    if (Array.isArray(node.orderby)) {
      for (const o of node.orderby) this.expr(isNode(o) ? o.expr : o);
    } else if (!isNil(node.orderby)) throw unsupported('Unrecognised ORDER BY.');
    if (!isNil(node.top) && !(isNode(node.top) && typeof node.top.value === 'number')) {
      throw unsupported('TOP must be a number.');
    }
    this.limit(node.limit);
    if (!isNil(node._next)) {
      if (typeof node.set_op !== 'string' || !SET_OPS.has(node.set_op.toLowerCase())) {
        throw unsupported('Unrecognised set operator.');
      }
      this.select(node._next, true);
    }
  }

  private limit(limit: unknown): void {
    if (isNil(limit)) return;
    if (!isNode(limit)) throw unsupported('Unrecognised LIMIT clause.');
    const parts: unknown[] = [];
    if (Array.isArray(limit.value)) parts.push(...limit.value);
    for (const key of ['offset', 'fetch']) {
      const p = limit[key];
      if (!isNil(p)) parts.push(isNode(p) ? p.value : p);
    }
    for (const p of parts) {
      if (!isNode(p) || p.type !== 'number') throw unsupported('LIMIT / FETCH must be numbers.');
    }
  }

  private from(item: unknown): void {
    if (!isNode(item)) throw unsupported('Unrecognised FROM item.');
    if (!isNil(item.operator)) throw unsupported('PIVOT / UNPIVOT is not allowed.');
    // The grammar reads `NATURAL` as an alias of the left table and the join
    // that follows as one with no ON, so the implicit join columns would never
    // be checked. Fail closed on both shapes.
    if (typeof item.as === 'string' && item.as.toUpperCase() === 'NATURAL') {
      throw unsupported('NATURAL JOIN is not allowed.');
    }
    if (!isNil(item.join)) {
      if (typeof item.join !== 'string' || !JOIN_KINDS.has(item.join.toUpperCase())) {
        throw unsupported(`Join ${String(item.join)} is not allowed.`);
      }
      if (!isNil(item.using)) throw unsupported('JOIN … USING is not allowed.');
      if (item.join.toUpperCase() !== 'CROSS JOIN' && isNil(item.on)) {
        throw unsupported(`${item.join.toUpperCase()} without ON is not allowed.`);
      }
    }
    // DUAL reads nothing, but a join on it still has its USING / ON checked and its ON read.
    if (item.type === 'dual') {
      this.expr(item.on);
      return;
    }
    if (!isNil(item.table_hint)) this.tableHint(item.table_hint);
    if (!isNil(item.temporal_table)) throw unsupported('Temporal tables are not allowed.');
    if (typeof item.table === 'string') {
      if (item.db || item.schema) {
        throw unsupported(
          `Schema-qualified table ${String(item.db)}.${item.table} is not allowed.`,
        );
      }
      if (!this.isVisibleCte(item.table)) {
        this.realKeys.add(item.table.toUpperCase());
        this.tables.push({
          name: item.table,
          ...(typeof item.as === 'string' ? { alias: item.as } : {}),
        });
      }
    } else if (isNode(item.expr) && isNode(item.expr.ast)) {
      this.select(item.expr.ast);
    } else {
      throw unsupported('Unrecognised FROM item.');
    }
    this.expr(item.on);
  }

  /**
   * Keyword rule for the first CONVERT argument, by dialect (see
   * {@link ReadAnalysisOptions}). Returns undefined when every argument is an
   * ordinary expression.
   */
  private convertRule(first: unknown): { words: ReadonlySet<string>; sized: boolean } | undefined {
    if (this.dialect === 'mssql') return KEYWORD_FIRST_ARG.get('CONVERT');
    if (this.dialect === 'oracle') return undefined;
    const ambiguous =
      isNode(first) &&
      ((first.type === 'column_ref' &&
        isNil(first.table) &&
        isNil(first.db) &&
        isNil(first.schema)) ||
        first.type === 'function');
    if (ambiguous) {
      throw unsupported(
        'CONVERT with a bare identifier or type as first argument needs the database dialect.',
      );
    }
    return undefined;
  }

  private tableHint(hint: unknown): void {
    const items = isNode(hint) && Array.isArray(hint.expr) ? hint.expr : null;
    const ok =
      items !== null &&
      items.every(
        (h: unknown) =>
          isNode(h) && isNode(h.expr) && String(h.expr.value).toUpperCase() === 'NOLOCK',
      );
    if (!ok) throw unsupported('Only the NOLOCK table hint is allowed.');
  }

  private exprs(list: unknown): void {
    if (isNil(list)) return;
    if (!Array.isArray(list)) throw unsupported('Unrecognised expression list.');
    for (const e of list) this.expr(e);
  }

  private over(over: unknown): void {
    if (isNil(over)) return;
    const spec =
      isNode(over) && isNode(over.as_window_specification)
        ? over.as_window_specification.window_specification
        : undefined;
    if (!isNode(spec) || !isNil(spec.name) || !isNil(spec.window_frame_clause)) {
      throw unsupported('Unrecognised window specification.');
    }
    if (Array.isArray(spec.partitionby)) {
      for (const p of spec.partitionby) this.expr(isNode(p) && 'expr' in p ? p.expr : p);
    }
    if (Array.isArray(spec.orderby)) {
      for (const o of spec.orderby) this.expr(isNode(o) ? o.expr : o);
    }
  }

  expr(e: unknown): void {
    if (isNil(e)) return;
    if (!isNode(e)) throw unsupported('Unrecognised expression.');
    if (isNode(e.ast)) {
      this.select(e.ast);
      return;
    }
    const type = e.type;
    if (typeof type === 'string' && LITERAL_TYPES.has(type)) return;
    switch (type) {
      case 'column_ref': {
        const name = columnText(e.column);
        if (name === undefined) throw unsupported('Unrecognised column reference.');
        const table = typeof e.table === 'string' ? e.table : undefined;
        if (e.db || e.schema) throw unsupported('Schema-qualified columns are not allowed.');
        if (name === '*') this.star.push(table ? { table } : {});
        else if (!table && NILADIC.has(name.toUpperCase())) this.useFunction(name.toUpperCase());
        else this.columns.push(table ? { table, name } : { name });
        return;
      }
      case 'double_quote_string':
        // ANSI quoted identifier: "INTO" is a column, not a string.
        if (typeof e.value !== 'string') throw unsupported('Unrecognised identifier.');
        this.columns.push({ name: e.value });
        return;
      case 'star':
        this.star.push({});
        return;
      case 'expr_list':
        this.exprs(e.value);
        return;
      case 'binary_expr':
        if (typeof e.operator !== 'string' || !BINARY_OPERATORS.has(e.operator.toUpperCase())) {
          throw unsupported(`Operator ${String(e.operator)} is not allowed.`);
        }
        this.expr(e.left);
        this.expr(e.right);
        return;
      case 'unary_expr':
        if (typeof e.operator !== 'string' || !UNARY_OPERATORS.has(e.operator.toUpperCase())) {
          throw unsupported(`Operator ${String(e.operator)} is not allowed.`);
        }
        this.expr(e.expr);
        return;
      case 'case':
        this.expr(e.expr);
        if (!Array.isArray(e.args)) throw unsupported('Unrecognised CASE.');
        for (const arm of e.args) {
          if (!isNode(arm) || (arm.type !== 'when' && arm.type !== 'else')) {
            throw unsupported('Unrecognised CASE arm.');
          }
          this.expr(arm.cond);
          this.expr(arm.result);
        }
        return;
      case 'cast':
        this.useFunction('CAST');
        this.expr(e.expr);
        return;
      case 'aggr_func': {
        const name = functionName(e);
        this.useFunction(name);
        if (isNode(e.args)) {
          if (!isNil(e.args.orderby) || !isNil(e.args.separator)) {
            throw unsupported(`Unsupported ${name} arguments.`);
          }
          const arg = e.args.expr;
          if (name === 'COUNT' && isNode(arg) && isStarArg(arg)) {
            const table =
              arg.type === 'column_ref' && typeof arg.table === 'string' ? arg.table : undefined;
            this.star.push(table ? { table, inAggregate: true } : { inAggregate: true });
          } else this.expr(arg);
        }
        this.over(e.over);
        return;
      }
      case 'function': {
        const name = functionName(e);
        this.useFunction(name);
        if (!isNil(e.within_group)) throw unsupported('WITHIN GROUP is not allowed.');
        const args = e.args;
        if (!isNil(args)) {
          if (!isNode(args) || args.type !== 'expr_list' || !Array.isArray(args.value)) {
            throw unsupported(`Unrecognised arguments for ${name}.`);
          }
          const values = [...args.value];
          const keyword =
            name === 'CONVERT' ? this.convertRule(values[0]) : KEYWORD_FIRST_ARG.get(name);
          if (keyword) {
            if (!isKeywordArg(values[0], keyword.words, keyword.sized)) {
              throw unsupported(`Unexpected first argument for ${name}.`);
            }
            values.shift();
          }
          this.exprs(values);
        }
        this.over(e.over);
        return;
      }
      default:
        throw unsupported(`Expression type ${String(type)} is not allowed.`);
    }
  }
}

/** `*` (or `t.*`) as an expression node, with nothing else (no schema, no subquery). */
function isStarArg(e: Node): boolean {
  if (e.type === 'star') return true;
  return (
    e.type === 'column_ref' && columnText(e.column) === '*' && !e.db && !e.schema && !isNode(e.ast)
  );
}

/** True when the outermost query, or any branch of its set-operator chain, has ORDER BY. */
function hasOuterOrderBy(ast: unknown): boolean {
  for (let node = ast; isNode(node); node = node._next) {
    if (Array.isArray(node.orderby) && node.orderby.length > 0) return true;
  }
  return false;
}

/** Output name of an unaliased select item, or undefined when it has none. */
function outputName(expr: Node): string | undefined {
  if (expr.type !== 'column_ref') return undefined;
  return columnText(expr.column);
}

/** See {@link ReadAnalysis.rowCapSafe}. */
function isRowCapSafe(ast: unknown): boolean {
  for (let node = ast; isNode(node); node = node._next) {
    const sources = Array.isArray(node.from) ? node.from.length : 0;
    if (node.columns === '*') {
      if (sources !== 1) return false;
      continue;
    }
    if (!Array.isArray(node.columns)) return false;
    const names = new Set<string>();
    for (const col of node.columns) {
      if (!isNode(col) || !isNode(col.expr)) return false;
      if (!isNil(col.as) && typeof col.as !== 'string') return false;
      const name = typeof col.as === 'string' ? col.as : outputName(col.expr);
      if (name === undefined) return false;
      if (name === '*') {
        if (col.expr.table || sources !== 1 || node.columns.length !== 1) return false;
        continue;
      }
      const key = name.toUpperCase();
      if (names.has(key)) return false;
      names.add(key);
    }
  }
  return true;
}

/**
 * Oracle folds unquoted identifiers to upper case and matches quoted ones exactly, while the
 * catalog check is case-insensitive. A quoted table name that is not upper case would name a
 * different object than the catalog entry it matched, so it is refused. So is such a CTE name:
 * CTEs are matched case-insensitively, and `"tgfpar"` would hide a read of the real `TGFPAR`.
 */
function assertOracleQuotedTables(sql: string, tables: { name: string }[]): void {
  const quoted = new Set<string>();
  for (const t of tokenize(sql, { ansi: true })) {
    if (t.type !== 'quotedIdent') continue;
    const close = t.text.startsWith('[') ? ']' : t.text.slice(0, 1);
    quoted.add(
      t.text
        .slice(1, t.unterminated ? undefined : -1)
        .split(close + close)
        .join(close),
    );
  }
  for (const { name } of tables) {
    if (name !== name.toUpperCase() && quoted.has(name)) {
      throw unsupported(`Quoted name "${name}" must be upper case on Oracle.`);
    }
  }
}

/**
 * Parses and allowlists a single read. Throws SQL_PARSE_ERROR / SQL_UNSUPPORTED.
 * `opts.dialect` selects how CONVERT is read; see {@link ReadAnalysisOptions}.
 */
export function analyzeRead(sql: string, opts: ReadAnalysisOptions = {}): ReadAnalysis {
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: 'transactsql' });
  } catch (err) {
    throw new AppError(
      'SQL_PARSE_ERROR',
      `Could not parse the statement: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`,
    );
  }
  if (Array.isArray(ast)) {
    if (ast.length !== 1) throw unsupported('Exactly one statement is allowed.');
    ast = ast[0];
  }
  const walker = new Walker(opts.dialect);
  walker.select(ast);
  walker.assertNoShadowing();
  if (opts.dialect === 'oracle') {
    assertOracleQuotedTables(sql, [...walker.tables, ...walker.ctes.map((name) => ({ name }))]);
  }
  return {
    orderBy: hasOuterOrderBy(ast),
    rowCapSafe: isRowCapSafe(ast),
    tables: walker.tables,
    columns: walker.columns,
    star: walker.star,
    functions: [...walker.functions],
    ctes: walker.ctes,
  };
}
