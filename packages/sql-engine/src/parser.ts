/**
 * Parses one SQL statement into the engine AST. node-sql-parser (MySQL grammar)
 * does the heavy lifting; this module is the only place that knows its output
 * shapes, and it rejects everything the engine does not support.
 */
import { AppError } from '@dbx/shared';
import parserPkg from 'node-sql-parser';
import type {
  AggregateFn,
  DeleteStatement,
  ExplainableStatement,
  Expr,
  InsertStatement,
  JoinClause,
  OrderItem,
  SelectItem,
  SelectStatement,
  Statement,
  TableRef,
  UpdateStatement,
} from './ast';
import { exprToSql } from './ast';
import { isSignificant, tokenize } from './tokenizer';
import type { Token } from './tokenizer';

const { Parser } = parserPkg;
const parser = new Parser();

export const MAX_SQL_LENGTH = 20_000;

// The external AST is loosely typed; we validate every node we touch.
type Node = Record<string, unknown>;

const unsupported = (message: string): AppError => new AppError('SQL_UNSUPPORTED', message);

const TRANSACTION_WORDS = new Set(['BEGIN', 'START', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE']);
const DDL_WORDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME']);
const STATEMENT_WORDS = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
]);

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ident(name: string): string {
  return name.trim().toLowerCase();
}

function significant(sql: string): Token[] {
  return tokenize(sql).filter(isSignificant);
}

function wordAt(tokens: Token[], i: number): string | undefined {
  const t = tokens[i];
  return t && t.type === 'word' ? t.text.toUpperCase() : undefined;
}

function identAt(tokens: Token[], i: number): string | undefined {
  const t = tokens[i];
  if (!t) return undefined;
  if (t.type === 'word') return ident(t.text);
  if (t.type === 'quotedIdent' && !t.unterminated)
    return ident(t.text.slice(1, -1).replace(/``/g, '`'));
  return undefined;
}

export function parseSql(sql: string): Statement {
  if (sql.length > MAX_SQL_LENGTH) {
    throw new AppError(
      'SQL_PARSE_ERROR',
      `The statement is too long (max ${MAX_SQL_LENGTH} characters).`,
    );
  }
  let tokens = significant(sql);
  const unterminated = tokenize(sql).find((t) => t.unterminated);
  if (unterminated) {
    throw new AppError(
      'SQL_PARSE_ERROR',
      `Unterminated ${unterminated.type === 'comment' ? 'comment' : 'string or identifier'} at offset ${unterminated.start}.`,
    );
  }
  // Allow exactly one statement, optionally followed by a semicolon.
  const semicolons = tokens.filter((t) => t.type === 'semicolon');
  if (semicolons.length > 0) {
    const firstSemi = tokens.indexOf(semicolons[0] as Token);
    if (tokens.slice(firstSemi).some((t) => t.type !== 'semicolon')) {
      throw unsupported('Only one statement can be executed at a time.');
    }
    tokens = tokens.slice(0, firstSemi);
  }
  if (tokens.length === 0) throw new AppError('SQL_PARSE_ERROR', 'The statement is empty.');
  const last = tokens[tokens.length - 1] as Token;
  const body = sql.slice(0, last.end);
  const first = wordAt(tokens, 0);

  if (first === 'EXPLAIN') {
    const second = tokens[1];
    if (!second) throw new AppError('SQL_PARSE_ERROR', 'EXPLAIN must be followed by a statement.');
    const inner = parseSql(body.slice(second.start));
    if (inner.type === 'explain' || inner.type === 'showTables' || inner.type === 'describe') {
      throw unsupported('EXPLAIN supports SELECT, INSERT, UPDATE and DELETE statements.');
    }
    return { type: 'explain', statement: inner };
  }
  if (first === 'SHOW') return parseShow(tokens);
  if (first === 'DESCRIBE' || first === 'DESC') {
    const table = identAt(tokens, 1);
    if (!table || tokens.length !== 2)
      throw new AppError('SQL_PARSE_ERROR', 'Usage: DESCRIBE <table>');
    return { type: 'describe', table };
  }
  if (first && TRANSACTION_WORDS.has(first)) {
    throw unsupported(
      'Transactions are not supported: every statement runs on its own and there is no rollback.',
    );
  }
  if (first && DDL_WORDS.has(first)) {
    throw unsupported('DDL is not supported: tables and columns come from the connected ERP.');
  }
  if (!first || !STATEMENT_WORDS.has(first)) {
    throw unsupported(
      `Unsupported statement${first ? ` "${first}"` : ''}. Supported: SELECT, INSERT, UPDATE, DELETE, SHOW, DESCRIBE, EXPLAIN.`,
    );
  }

  let ast: unknown;
  try {
    ast = parser.astify(body, { database: 'mysql' });
  } catch (err) {
    throw toParseError(err);
  }
  const list = Array.isArray(ast) ? ast : [ast];
  if (list.length !== 1) throw unsupported('Only one statement can be executed at a time.');
  return convertStatement(list[0]);
}

function toParseError(err: unknown): AppError {
  const e = err as { message?: string; location?: { start?: { line?: number; column?: number } } };
  const loc = e.location?.start;
  const where = loc?.line !== undefined ? ` at line ${loc.line}, column ${loc.column ?? '?'}` : '';
  const detail = (e.message ?? 'invalid syntax').replace(/\s+/g, ' ').slice(0, 240);
  return new AppError(
    'SQL_PARSE_ERROR',
    `Syntax error${where}: ${detail}`,
    loc ? { line: loc.line, column: loc.column } : undefined,
  );
}

function parseShow(tokens: Token[]): Statement {
  const what = wordAt(tokens, 1);
  if (what === 'TABLES' && tokens.length === 2) return { type: 'showTables' };
  if (
    (what === 'COLUMNS' || what === 'FIELDS') &&
    (wordAt(tokens, 2) === 'FROM' || wordAt(tokens, 2) === 'IN')
  ) {
    const table = identAt(tokens, 3);
    if (table && tokens.length === 4) return { type: 'describe', table };
  }
  throw new AppError('SQL_PARSE_ERROR', 'Usage: SHOW TABLES | SHOW COLUMNS FROM <table>');
}

function convertStatement(node: unknown): Statement {
  if (!isNode(node)) throw new AppError('SQL_PARSE_ERROR', 'Could not parse the statement.');
  switch (node.type) {
    case 'select':
      return convertSelect(node);
    case 'insert':
      return convertInsert(node);
    case 'update':
      return convertUpdate(node);
    case 'delete':
      return convertDelete(node);
    case 'replace':
      throw unsupported('REPLACE is not supported.');
    default:
      throw unsupported(`Unsupported statement type "${String(node.type)}".`);
  }
}

function rejectSubquery(node: Node): void {
  if ('ast' in node && node.ast) throw unsupported('Subqueries are not supported.');
  if (node.type === 'select') throw unsupported('Subqueries are not supported.');
}

function convertTableRef(node: unknown, context: string): TableRef {
  if (!isNode(node)) throw new AppError('SQL_PARSE_ERROR', `Invalid table in ${context}.`);
  if (node.expr) throw unsupported('Subqueries in FROM are not supported.');
  if (node.db) throw unsupported('Schema-qualified table names are not supported.');
  if (typeof node.table !== 'string')
    throw new AppError('SQL_PARSE_ERROR', `Invalid table in ${context}.`);
  const ref: TableRef = { name: ident(node.table) };
  if (typeof node.as === 'string' && node.as) ref.alias = ident(node.as);
  return ref;
}

function convertSelect(node: Node): SelectStatement {
  if (node.with) throw unsupported('WITH (CTE) is not supported.');
  if (node._next || node.set_op) throw unsupported('UNION / INTERSECT / EXCEPT are not supported.');
  if (isNode(node.into) && node.into.position)
    throw unsupported('SELECT ... INTO is not supported.');
  if (node.locking_read) throw unsupported('Locking reads are not supported.');
  if (node.window) throw unsupported('Window functions are not supported.');
  if (Array.isArray(node.options) && node.options.length > 0)
    throw unsupported('SELECT options are not supported.');

  const stmt: SelectStatement = {
    type: 'select',
    distinct: node.distinct === 'DISTINCT',
    columns: [],
    joins: [],
    groupBy: [],
    orderBy: [],
  };

  if (Array.isArray(node.from) && node.from.length > 0) {
    const [base, ...rest] = node.from as unknown[];
    if (isNode(base) && base.join) throw new AppError('SQL_PARSE_ERROR', 'Invalid FROM clause.');
    stmt.from = convertTableRef(base, 'FROM');
    for (const item of rest) {
      if (!isNode(item)) throw new AppError('SQL_PARSE_ERROR', 'Invalid JOIN.');
      const kind = typeof item.join === 'string' ? item.join.toUpperCase() : '';
      if (!kind)
        throw unsupported(
          'Comma joins are not supported; use INNER JOIN ... ON or LEFT JOIN ... ON.',
        );
      let type: JoinClause['type'];
      if (kind === 'JOIN' || kind === 'INNER JOIN') type = 'INNER';
      else if (kind === 'LEFT JOIN' || kind === 'LEFT OUTER JOIN') type = 'LEFT';
      else throw unsupported(`${kind} is not supported; use INNER JOIN or LEFT JOIN.`);
      if (item.using) throw unsupported('JOIN ... USING is not supported; use ON.');
      if (!item.on) throw unsupported('JOIN requires an ON condition.');
      stmt.joins.push({ type, table: convertTableRef(item, 'JOIN'), on: convertExpr(item.on) });
    }
  }

  const columns = node.columns;
  if (columns === '*') {
    stmt.columns.push({ kind: 'star' });
  } else if (Array.isArray(columns)) {
    for (const col of columns as unknown[]) stmt.columns.push(convertSelectItem(col));
  } else {
    throw new AppError('SQL_PARSE_ERROR', 'Invalid select list.');
  }

  if (node.where) stmt.where = convertExpr(node.where);

  const groupby = isNode(node.groupby) ? node.groupby.columns : node.groupby;
  if (Array.isArray(groupby)) {
    for (const g of groupby as unknown[]) {
      const pos = positionOf(g);
      stmt.groupBy.push(pos ?? convertExpr(g));
    }
  }
  if (node.having) stmt.having = convertExpr(node.having);
  if (Array.isArray(node.orderby)) {
    for (const o of node.orderby as unknown[]) {
      if (!isNode(o)) continue;
      const pos = positionOf(o.expr);
      const item: OrderItem = {
        expr: pos ?? convertExpr(o.expr),
        desc: String(o.type ?? '').toUpperCase() === 'DESC',
      };
      stmt.orderBy.push(item);
    }
  }
  Object.assign(stmt, convertLimit(node.limit));
  return stmt;
}

function positionOf(node: unknown): { kind: 'position'; index: number } | undefined {
  if (isNode(node) && node.type === 'number') {
    const n = Number(node.value);
    if (!Number.isInteger(n) || n < 1)
      throw new AppError('SQL_PARSE_ERROR', 'Positional references must be positive integers.');
    return { kind: 'position', index: n };
  }
  return undefined;
}

function convertLimit(limit: unknown): { limit?: number; offset?: number } {
  if (!isNode(limit) || !Array.isArray(limit.value) || limit.value.length === 0) return {};
  const nums = (limit.value as unknown[]).map((v) => {
    if (!isNode(v) || v.type !== 'number')
      throw unsupported('LIMIT and OFFSET must be integer literals.');
    const n = Number(v.value);
    if (!Number.isInteger(n) || n < 0)
      throw unsupported('LIMIT and OFFSET must be non-negative integers.');
    return n;
  });
  if (nums.length === 1) return { limit: nums[0] as number };
  if (limit.seperator === ',') return { offset: nums[0] as number, limit: nums[1] as number };
  return { limit: nums[0] as number, offset: nums[1] as number };
}

function columnName(node: Node): string | undefined {
  const col = node.column;
  if (typeof col === 'string') return col;
  if (isNode(col) && isNode(col.expr) && typeof col.expr.value === 'string') return col.expr.value;
  return undefined;
}

function convertSelectItem(col: unknown): SelectItem {
  if (!isNode(col)) throw new AppError('SQL_PARSE_ERROR', 'Invalid select list.');
  const expr = col.expr;
  if (isNode(expr) && expr.type === 'column_ref' && columnName(expr) === '*') {
    if (col.as) throw new AppError('SQL_PARSE_ERROR', 'A * cannot have an alias.');
    return typeof expr.table === 'string' && expr.table
      ? { kind: 'star', table: ident(expr.table) }
      : { kind: 'star' };
  }
  if (isNode(expr) && expr.type === 'star') return { kind: 'star' };
  const converted = convertExpr(expr);
  const item: SelectItem = {
    kind: 'expr',
    expr: converted,
    text: converted.kind === 'column' ? converted.name : exprToSql(converted),
  };
  if (typeof col.as === 'string' && col.as) item.alias = col.as.trim();
  return item;
}

function unquote(node: Node): string {
  const raw = String(node.value ?? '');
  if (node.type === 'double_quote_string')
    return raw.replace(/""/g, '"').replace(/\\(["\\])/g, '$1');
  return raw.replace(/''/g, "'").replace(/\\(['\\])/g, '$1');
}

const STRING_TYPES = new Set([
  'single_quote_string',
  'double_quote_string',
  'string',
  'natural_string',
  'regex_string',
]);
const COMPARE: Record<string, Extract<Expr, { kind: 'compare' }>['op']> = {
  '=': '=',
  '!=': '<>',
  '<>': '<>',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
};
const ARITH = new Set(['+', '-', '*', '/']);
const AGGREGATES = new Set<AggregateFn>(['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']);

function functionName(node: Node): string {
  const name = node.name;
  if (typeof name === 'string') return name.toUpperCase();
  if (isNode(name) && Array.isArray(name.name)) {
    return (name.name as unknown[])
      .map((p) => (isNode(p) ? String(p.value ?? '') : ''))
      .join('.')
      .toUpperCase();
  }
  return '?';
}

export function convertExpr(input: unknown): Expr {
  if (!isNode(input)) throw new AppError('SQL_PARSE_ERROR', 'Invalid expression.');
  const node = input;
  rejectSubquery(node);
  const type = String(node.type);

  if (type === 'number') {
    const n = Number(node.value);
    if (!Number.isFinite(n))
      throw new AppError('SQL_PARSE_ERROR', `Invalid number ${String(node.value)}.`);
    return { kind: 'literal', value: n };
  }
  if (STRING_TYPES.has(type)) return { kind: 'literal', value: unquote(node) };
  if (type === 'bool') return { kind: 'literal', value: Boolean(node.value) };
  if (type === 'null') return { kind: 'literal', value: null };
  if (type === 'column_ref') {
    const name = columnName(node);
    if (!name) throw new AppError('SQL_PARSE_ERROR', 'Invalid column reference.');
    if (name === '*') throw unsupported('* is only allowed in the select list or COUNT(*).');
    const col: Expr = { kind: 'column', name: ident(name) };
    if (typeof node.table === 'string' && node.table) col.table = ident(node.table);
    if (node.db || node.schema)
      throw unsupported('Schema-qualified column names are not supported.');
    return col;
  }
  if (type === 'unary_expr') {
    const op = String(node.operator).toUpperCase();
    const inner = convertExpr(node.expr);
    if (op === '-') {
      if (inner.kind === 'literal' && typeof inner.value === 'number')
        return { kind: 'literal', value: -inner.value };
      return { kind: 'neg', expr: inner };
    }
    if (op === '+') return inner;
    if (op === 'NOT' || op === '!') return { kind: 'not', expr: inner };
    throw unsupported(`Operator ${op} is not supported.`);
  }
  if (type === 'binary_expr') return convertBinary(node);
  if (type === 'aggr_func') return convertAggregate(node);
  if (type === 'function') {
    const name = functionName(node);
    if (name === 'NOT') {
      const args =
        isNode(node.args) && Array.isArray(node.args.value) ? (node.args.value as unknown[]) : [];
      if (args.length !== 1) throw new AppError('SQL_PARSE_ERROR', 'NOT expects one operand.');
      return { kind: 'not', expr: convertExpr(args[0]) };
    }
    throw unsupported(
      `Function ${name}() is not supported. Supported aggregates: COUNT, SUM, AVG, MIN, MAX.`,
    );
  }
  if (type === 'origin' || type === 'param' || type === 'var') {
    throw unsupported('Placeholders and variables are not supported; write literal values.');
  }
  if (type === 'expr_list') throw unsupported('Value lists are only allowed after IN.');
  if (type === 'case') throw unsupported('CASE expressions are not supported.');
  if (type === 'cast') throw unsupported('CAST is not supported.');
  if (type === 'interval') throw unsupported('INTERVAL is not supported.');
  throw unsupported(`Expression type "${type}" is not supported.`);
}

function convertBinary(node: Node): Expr {
  const op = String(node.operator).toUpperCase();
  if (op === 'AND' || op === '&&')
    return { kind: 'and', left: convertExpr(node.left), right: convertExpr(node.right) };
  if (op === 'OR' || op === '||')
    return { kind: 'or', left: convertExpr(node.left), right: convertExpr(node.right) };
  const compare = COMPARE[op];
  if (compare)
    return {
      kind: 'compare',
      op: compare,
      left: convertExpr(node.left),
      right: convertExpr(node.right),
    };
  if (ARITH.has(op)) {
    return {
      kind: 'arith',
      op: op as '+' | '-' | '*' | '/',
      left: convertExpr(node.left),
      right: convertExpr(node.right),
    };
  }
  if (op === 'IN' || op === 'NOT IN') {
    const right = node.right;
    if (!isNode(right) || right.type !== 'expr_list' || !Array.isArray(right.value)) {
      throw unsupported('IN expects a list of values; subqueries are not supported.');
    }
    const list = (right.value as unknown[]).map(convertExpr);
    if (list.length === 0) throw new AppError('SQL_PARSE_ERROR', 'IN list cannot be empty.');
    return { kind: 'in', expr: convertExpr(node.left), list, negated: op === 'NOT IN' };
  }
  if (op === 'BETWEEN' || op === 'NOT BETWEEN') {
    const right = node.right;
    if (!isNode(right) || !Array.isArray(right.value) || right.value.length !== 2) {
      throw new AppError('SQL_PARSE_ERROR', 'BETWEEN expects two bounds.');
    }
    const [low, high] = right.value as unknown[];
    return {
      kind: 'between',
      expr: convertExpr(node.left),
      low: convertExpr(low),
      high: convertExpr(high),
      negated: op === 'NOT BETWEEN',
    };
  }
  if (op === 'LIKE' || op === 'NOT LIKE') {
    const right = node.right;
    const like: Expr = {
      kind: 'like',
      expr: convertExpr(node.left),
      pattern: convertExpr(right),
      negated: op === 'NOT LIKE',
    };
    if (isNode(right) && isNode(right.escape)) {
      const esc = right.escape.value;
      const escValue = isNode(esc) ? unquote(esc) : String(esc ?? '');
      if (escValue.length !== 1)
        throw new AppError('SQL_PARSE_ERROR', 'ESCAPE must be a single character.');
      like.escape = escValue;
    }
    return like;
  }
  if (op === 'IS' || op === 'IS NOT') {
    const right = node.right;
    if (isNode(right) && right.type === 'null') {
      return { kind: 'isNull', expr: convertExpr(node.left), negated: op === 'IS NOT' };
    }
    throw unsupported(
      "Only IS NULL / IS NOT NULL are supported. Flags use 'S' / 'N': WHERE inativo = 'N'.",
    );
  }
  throw unsupported(`Operator ${op} is not supported.`);
}

function convertAggregate(node: Node): Expr {
  const name = String(node.name).toUpperCase() as AggregateFn;
  if (!AGGREGATES.has(name)) throw unsupported(`Aggregate ${name}() is not supported.`);
  if (node.over) throw unsupported('Window functions are not supported.');
  const args = isNode(node.args) ? node.args : {};
  const distinct = args.distinct === 'DISTINCT';
  const argExpr = args.expr;
  if (
    isNode(argExpr) &&
    (argExpr.type === 'star' || (argExpr.type === 'column_ref' && columnName(argExpr) === '*'))
  ) {
    if (name !== 'COUNT') throw new AppError('SQL_PARSE_ERROR', `${name}(*) is not valid.`);
    if (distinct) throw new AppError('SQL_PARSE_ERROR', 'COUNT(DISTINCT *) is not valid.');
    return { kind: 'aggregate', fn: name, arg: '*', distinct: false };
  }
  const arg = convertExpr(argExpr);
  return { kind: 'aggregate', fn: name, arg, distinct };
}

function singleTable(node: unknown, context: string): TableRef {
  const list = Array.isArray(node) ? (node as unknown[]) : [node];
  if (list.length !== 1) throw unsupported(`${context} supports exactly one table.`);
  const first = list[0];
  if (isNode(first) && first.join) throw unsupported(`${context} with JOIN is not supported.`);
  return convertTableRef(first, context);
}

function convertInsert(node: Node): InsertStatement {
  if (node.prefix && String(node.prefix).toUpperCase().includes('IGNORE'))
    throw unsupported('INSERT IGNORE is not supported.');
  if (node.on_duplicate_update) throw unsupported('ON DUPLICATE KEY UPDATE is not supported.');
  if (node.set)
    throw unsupported('INSERT ... SET is not supported; use INSERT INTO t (cols) VALUES (...).');
  const table = singleTable(node.table, 'INSERT');
  if (!Array.isArray(node.columns) || node.columns.length === 0) {
    throw unsupported(
      'INSERT requires an explicit column list: INSERT INTO t (col1, col2) VALUES (...).',
    );
  }
  const columns = (node.columns as unknown[]).map((c) => {
    if (typeof c === 'string') return ident(c);
    if (isNode(c)) {
      const n = columnName(c) ?? (typeof c.value === 'string' ? c.value : undefined);
      if (n) return ident(n);
    }
    throw new AppError('SQL_PARSE_ERROR', 'Invalid column list.');
  });
  const values = node.values;
  const rows =
    isNode(values) && Array.isArray(values.values)
      ? (values.values as unknown[])
      : Array.isArray(values)
        ? (values as unknown[])
        : undefined;
  if (!rows) {
    if (isNode(values) && values.type === 'select')
      throw unsupported('INSERT ... SELECT is not supported.');
    throw unsupported('INSERT requires a VALUES list.');
  }
  if (rows.length !== 1)
    throw unsupported('Only single-row INSERT is supported; run one INSERT per record.');
  const row = rows[0];
  if (!isNode(row) || !Array.isArray(row.value))
    throw new AppError('SQL_PARSE_ERROR', 'Invalid VALUES list.');
  const exprs = (row.value as unknown[]).map(convertExpr);
  if (exprs.length !== columns.length) {
    throw new AppError(
      'SQL_PARSE_ERROR',
      `INSERT has ${columns.length} columns but ${exprs.length} values.`,
    );
  }
  if (new Set(columns).size !== columns.length)
    throw new AppError('SQL_PARSE_ERROR', 'Duplicate column in INSERT.');
  return { type: 'insert', table: table.name, columns, values: exprs };
}

function convertUpdate(node: Node): UpdateStatement {
  if (node.orderby || node.limit)
    throw unsupported('UPDATE ... ORDER BY / LIMIT is not supported.');
  const table = singleTable(node.table, 'UPDATE');
  if (node.from) throw unsupported('UPDATE ... FROM is not supported.');
  if (!Array.isArray(node.set) || node.set.length === 0)
    throw new AppError('SQL_PARSE_ERROR', 'UPDATE requires SET.');
  const set = (node.set as unknown[]).map((s) => {
    const column = isNode(s) ? columnName(s) : undefined;
    if (!isNode(s) || column === undefined)
      throw new AppError('SQL_PARSE_ERROR', 'Invalid SET clause.');
    if (
      s.table &&
      (!table.alias || ident(String(s.table)) !== table.alias) &&
      ident(String(s.table)) !== table.name
    ) {
      throw new AppError('COLUMN_NOT_FOUND', `Unknown table "${String(s.table)}" in SET.`);
    }
    return { column: ident(column), value: convertExpr(s.value) };
  });
  if (new Set(set.map((s) => s.column)).size !== set.length)
    throw new AppError('SQL_PARSE_ERROR', 'Duplicate column in SET.');
  const stmt: UpdateStatement = { type: 'update', table, set };
  if (node.where) stmt.where = convertExpr(node.where);
  return stmt;
}

function convertDelete(node: Node): DeleteStatement {
  if (node.orderby || node.limit)
    throw unsupported('DELETE ... ORDER BY / LIMIT is not supported.');
  const table = singleTable(node.from, 'DELETE');
  if (Array.isArray(node.table) && node.table.length > 1)
    throw unsupported('Multi-table DELETE is not supported.');
  const stmt: DeleteStatement = { type: 'delete', table };
  if (node.where) stmt.where = convertExpr(node.where);
  return stmt;
}

/**
 * Converts an already-parsed INSERT / UPDATE / DELETE node (MySQL or
 * PostgreSQL grammar) into the engine write AST. Used by the classifier.
 */
export function convertWriteNode(
  node: unknown,
): InsertStatement | UpdateStatement | DeleteStatement {
  if (!isNode(node)) throw new AppError('SQL_PARSE_ERROR', 'Invalid statement.');
  if (node.type === 'insert') return convertInsert(node);
  if (node.type === 'update') return convertUpdate(node);
  if (node.type === 'delete') return convertDelete(node);
  throw unsupported(`Not a write statement: ${String(node.type)}.`);
}

/** Statement kind used for RBAC and history. */
export function statementKind(
  s: Statement,
): 'SELECT' | 'SHOW' | 'DESCRIBE' | 'EXPLAIN' | 'INSERT' | 'UPDATE' | 'DELETE' {
  switch (s.type) {
    case 'select':
      return 'SELECT';
    case 'showTables':
      return 'SHOW';
    case 'describe':
      return 'DESCRIBE';
    case 'explain':
      return 'EXPLAIN';
    case 'insert':
      return 'INSERT';
    case 'update':
      return 'UPDATE';
    case 'delete':
      return 'DELETE';
  }
}

export type { ExplainableStatement };
