/**
 * The engine's own AST. The third-party parser output is converted into these
 * types (see parser.ts) so the rest of the engine never depends on its shapes.
 */

export type Literal = string | number | boolean | null;

export type ComparisonOp = '=' | '<>' | '>' | '>=' | '<' | '<=';
export type ArithmeticOp = '+' | '-' | '*' | '/';
export type AggregateFn = 'COUNT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';

export type Expr =
  | { kind: 'literal'; value: Literal }
  | { kind: 'column'; table?: string; name: string }
  | { kind: 'compare'; op: ComparisonOp; left: Expr; right: Expr }
  | { kind: 'arith'; op: ArithmeticOp; left: Expr; right: Expr }
  | { kind: 'and'; left: Expr; right: Expr }
  | { kind: 'or'; left: Expr; right: Expr }
  | { kind: 'not'; expr: Expr }
  | { kind: 'neg'; expr: Expr }
  | { kind: 'in'; expr: Expr; list: Expr[]; negated: boolean }
  | { kind: 'between'; expr: Expr; low: Expr; high: Expr; negated: boolean }
  | { kind: 'like'; expr: Expr; pattern: Expr; negated: boolean; escape?: string }
  | { kind: 'isNull'; expr: Expr; negated: boolean }
  | { kind: 'aggregate'; fn: AggregateFn; arg: Expr | '*'; distinct: boolean };

export interface TableRef {
  name: string;
  alias?: string;
}

export type SelectItem =
  { kind: 'star'; table?: string } | { kind: 'expr'; expr: Expr; alias?: string; text: string };

export interface JoinClause {
  type: 'INNER' | 'LEFT';
  table: TableRef;
  on: Expr;
}

export interface OrderItem {
  /** Either an expression or a 1-based position in the select list. */
  expr: Expr | { kind: 'position'; index: number };
  desc: boolean;
}

export interface SelectStatement {
  type: 'select';
  distinct: boolean;
  columns: SelectItem[];
  from?: TableRef;
  joins: JoinClause[];
  where?: Expr;
  groupBy: Array<Expr | { kind: 'position'; index: number }>;
  having?: Expr;
  orderBy: OrderItem[];
  limit?: number;
  offset?: number;
}

export interface InsertStatement {
  type: 'insert';
  table: string;
  columns: string[];
  values: Expr[];
}

export interface UpdateStatement {
  type: 'update';
  table: TableRef;
  set: Array<{ column: string; value: Expr }>;
  where?: Expr;
}

export interface DeleteStatement {
  type: 'delete';
  table: TableRef;
  where?: Expr;
}

export interface ShowTablesStatement {
  type: 'showTables';
}

export interface DescribeStatement {
  type: 'describe';
  table: string;
}

export type ExplainableStatement =
  SelectStatement | InsertStatement | UpdateStatement | DeleteStatement;

export interface ExplainStatement {
  type: 'explain';
  statement: ExplainableStatement;
}

export type Statement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | ShowTablesStatement
  | DescribeStatement
  | ExplainStatement;

export type WriteStatement = InsertStatement | UpdateStatement | DeleteStatement;

export function isWriteStatement(s: Statement): s is WriteStatement {
  return s.type === 'insert' || s.type === 'update' || s.type === 'delete';
}

/** Splits a predicate into its top-level AND conjuncts. */
export function conjuncts(expr: Expr | undefined): Expr[] {
  if (!expr) return [];
  if (expr.kind === 'and') return [...conjuncts(expr.left), ...conjuncts(expr.right)];
  return [expr];
}

export function containsAggregate(expr: Expr): boolean {
  switch (expr.kind) {
    case 'aggregate':
      return true;
    case 'literal':
    case 'column':
      return false;
    case 'not':
    case 'neg':
    case 'isNull':
      return containsAggregate(expr.expr);
    case 'in':
      return containsAggregate(expr.expr) || expr.list.some(containsAggregate);
    case 'between':
      return (
        containsAggregate(expr.expr) || containsAggregate(expr.low) || containsAggregate(expr.high)
      );
    case 'like':
      return containsAggregate(expr.expr) || containsAggregate(expr.pattern);
    default:
      return containsAggregate(expr.left) || containsAggregate(expr.right);
  }
}

/** Visits every column reference, including those inside aggregate arguments. */
export function walkColumns(
  expr: Expr,
  visit: (col: Extract<Expr, { kind: 'column' }>) => void,
): void {
  switch (expr.kind) {
    case 'column':
      visit(expr);
      return;
    case 'literal':
      return;
    case 'aggregate':
      if (expr.arg !== '*') walkColumns(expr.arg, visit);
      return;
    case 'not':
    case 'neg':
    case 'isNull':
      walkColumns(expr.expr, visit);
      return;
    case 'in':
      walkColumns(expr.expr, visit);
      expr.list.forEach((e) => walkColumns(e, visit));
      return;
    case 'between':
      walkColumns(expr.expr, visit);
      walkColumns(expr.low, visit);
      walkColumns(expr.high, visit);
      return;
    case 'like':
      walkColumns(expr.expr, visit);
      walkColumns(expr.pattern, visit);
      return;
    default:
      walkColumns(expr.left, visit);
      walkColumns(expr.right, visit);
  }
}

/** Stable textual form used for column headers and GROUP BY matching. */
export function exprToSql(expr: Expr): string {
  switch (expr.kind) {
    case 'literal':
      if (expr.value === null) return 'NULL';
      if (typeof expr.value === 'string') return `'${expr.value.replace(/'/g, "''")}'`;
      if (typeof expr.value === 'boolean') return expr.value ? 'TRUE' : 'FALSE';
      return String(expr.value);
    case 'column':
      return expr.table ? `${expr.table}.${expr.name}` : expr.name;
    case 'compare':
    case 'arith':
      return `${exprToSql(expr.left)} ${expr.op} ${exprToSql(expr.right)}`;
    case 'and':
      return `(${exprToSql(expr.left)} AND ${exprToSql(expr.right)})`;
    case 'or':
      return `(${exprToSql(expr.left)} OR ${exprToSql(expr.right)})`;
    case 'not':
      return `NOT (${exprToSql(expr.expr)})`;
    case 'neg':
      return `-${exprToSql(expr.expr)}`;
    case 'in':
      return `${exprToSql(expr.expr)} ${expr.negated ? 'NOT IN' : 'IN'} (${expr.list.map(exprToSql).join(', ')})`;
    case 'between':
      return `${exprToSql(expr.expr)} ${expr.negated ? 'NOT BETWEEN' : 'BETWEEN'} ${exprToSql(expr.low)} AND ${exprToSql(expr.high)}`;
    case 'like':
      return `${exprToSql(expr.expr)} ${expr.negated ? 'NOT LIKE' : 'LIKE'} ${exprToSql(expr.pattern)}${
        expr.escape !== undefined ? ` ESCAPE '${expr.escape}'` : ''
      }`;
    case 'isNull':
      return `${exprToSql(expr.expr)} IS ${expr.negated ? 'NOT NULL' : 'NULL'}`;
    case 'aggregate':
      return `${expr.fn}(${expr.distinct ? 'DISTINCT ' : ''}${expr.arg === '*' ? '*' : exprToSql(expr.arg)})`;
  }
}
