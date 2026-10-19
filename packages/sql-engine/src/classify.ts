/**
 * AST-based statement classifier. Decides WHAT a statement is (never by its
 * leading word): it parses with the PostgreSQL grammar (the scratch dialect),
 * falling back to T-SQL for reads only, and anything it cannot positively
 * identify is UNKNOWN. Comments are fine here; the read gate is separate.
 */
import parserPkg from 'node-sql-parser';
import type { WriteStatement } from './ast';
import { convertWriteNode } from './parser';

const { Parser } = parserPkg;
const parser = new Parser();

type Node = Record<string, unknown>;

export type WriteKind = 'INSERT' | 'UPDATE' | 'DELETE';
export type DdlKind = 'CREATE_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE';

export type Classified =
  | { kind: 'SELECT'; tables: string[] }
  | {
      kind: WriteKind;
      /** Target table, case preserved. */
      table: string;
      /** False for UPDATE / DELETE without WHERE (always false for INSERT). */
      hasWhere: boolean;
      /** Tables read by the statement (INSERT … SELECT, subqueries). */
      sourceTables: string[];
      /** Engine write AST when the shape is supported (single-row INSERT, simple UPDATE/DELETE). */
      stmt?: WriteStatement;
      stmtError?: string;
    }
  | {
      kind: DdlKind;
      table: string;
      temporary: boolean;
      /** Tables read by CREATE TABLE … AS SELECT. */
      sourceTables: string[];
      ast: unknown;
    }
  | { kind: 'UNKNOWN'; reason: string };

/** Nullish check (the AST uses both null and undefined for absent parts). */
function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const unknown = (reason: string): Classified => ({ kind: 'UNKNOWN', reason });

interface Parsed {
  ast: unknown;
  tableList: string[];
}

function tryParse(sql: string, database: string): Parsed | Error {
  try {
    const r = parser.parse(sql, { database });
    return { ast: r.ast, tableList: r.tableList };
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** tableList entries look like `select::db::TABLE`. */
function tablesFor(tableList: string[], action: string, exclude: Set<string>): string[] {
  const out: string[] = [];
  for (const entry of tableList) {
    const [kind, , name] = entry.split('::');
    if (!kind || !name || kind.toLowerCase() !== action) continue;
    if (exclude.has(name.toUpperCase()) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

class CteError extends Error {}

/** A table reference node: `{ db, table, as }` (FROM items, write targets, DDL names). */
function isTableRef(node: Node): node is Node & { table: string } {
  return typeof node.table === 'string' && node.type !== 'column_ref' && !('column' in node);
}

/** Statement node types that change data; never allowed below the root statement. */
const NESTED_STATEMENT_TYPES = new Set(['insert', 'update', 'delete', 'replace', 'merge']);

/**
 * Walks the whole AST with lexically scoped CTE names and returns every CTE
 * name (upper-case). A CTE name is visible only after its own body (to later
 * CTEs of the same WITH and the query it introduces, including its set-operator
 * chain). Fails closed, returning a reason, when CTE names repeat, when a WITH
 * follows a set operator, when a CTE name collides with any real table read
 * anywhere in the statement, or when the parser's table list holds a name this
 * walk did not account for. Once it succeeds, a table-list name equal to a CTE
 * name can only be a CTE reference, so excluding CTE names is safe.
 */
function scanCtes(root: Node, tableList: string[]): Set<string> | string {
  const ctes = new Set<string>();
  const real = new Set<string>();
  const scopes: Set<string>[] = [];

  const walk = (value: unknown, chained: boolean): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v, false);
      return;
    }
    if (!isNode(value)) return;
    if (isNil(value.with)) {
      walkRest(value);
      return;
    }
    if (!Array.isArray(value.with)) throw new CteError('Unrecognised WITH clause.');
    if (chained) throw new CteError('WITH is only allowed at the start of a query.');
    const scope = new Set<string>();
    scopes.push(scope);
    try {
      for (const cte of value.with) {
        const name = isNode(cte) ? (isNode(cte.name) ? cte.name.value : cte.name) : undefined;
        if (!isNode(cte) || typeof name !== 'string') throw new CteError('Unrecognised CTE.');
        const key = name.toUpperCase();
        if (ctes.has(key)) throw new CteError(`CTE name ${name} is defined twice.`);
        // pg: stmt is the query node; T-SQL: stmt is { tableList, columnList, ast }.
        const body = isNode(cte.stmt) && isNode(cte.stmt.ast) ? cte.stmt.ast : cte.stmt;
        if (!isNode(body) || body.type !== 'select') {
          throw new CteError(`CTE ${name} must be a plain SELECT.`);
        }
        walk(cte.stmt, false);
        ctes.add(key);
        scope.add(key);
      }
      walkRest(value);
    } finally {
      scopes.pop();
    }
  };

  const walkRest = (node: Node): void => {
    if (node !== root && typeof node.type === 'string' && NESTED_STATEMENT_TYPES.has(node.type)) {
      throw new CteError(`A nested ${node.type.toUpperCase()} is not allowed.`);
    }
    if (isTableRef(node)) {
      const key = node.table.toUpperCase();
      const qualified = !isNil(node.db) || !isNil(node.schema);
      if (qualified || !scopes.some((sc) => sc.has(key))) real.add(key);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'with') walk(v, k === '_next');
    }
  };

  try {
    walk(root, false);
  } catch (err) {
    if (err instanceof CteError) return err.message;
    throw err;
  }
  for (const key of ctes) {
    if (real.has(key)) return `CTE name ${key} collides with a table used by the statement.`;
  }
  for (const entry of tableList) {
    const name = entry.split('::')[2];
    const key = name?.toUpperCase();
    if (!key || (!real.has(key) && !ctes.has(key))) {
      return `Unrecognised table reference ${String(name)}.`;
    }
  }
  return ctes;
}

/**
 * True when every tableList action is one the statement kind may perform, so a
 * write hidden anywhere in the statement (e.g. a data-modifying CTE) can never
 * pass as a read.
 */
function actionsAllowed(tableList: string[], allowed: readonly string[]): boolean {
  return tableList.every((entry) => allowed.includes((entry.split('::')[0] ?? '').toLowerCase()));
}

function isPlainSelect(ast: Node): boolean {
  if (ast.type !== 'select') return false;
  if (isNode(ast.into) && !isNil(ast.into.position)) return false;
  if (!isNil(ast.for) || !isNil(ast.locking_read)) return false;
  return true;
}

function single(parsed: Parsed): Node | string {
  const list = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
  if (list.length !== 1) return 'Exactly one statement is allowed.';
  const node = list[0];
  return isNode(node) ? node : 'Unrecognised statement.';
}

function tableName(entry: unknown): string | undefined {
  if (!isNode(entry) || typeof entry.table !== 'string') return undefined;
  if (!isNil(entry.db) || !isNil(entry.schema)) return undefined;
  return entry.table;
}

export function classifyStatement(sql: string): Classified {
  if (sql.trim() === '') return unknown('The statement is empty.');
  const pg = tryParse(sql, 'postgresql');
  if (pg instanceof Error) {
    // Reads may use T-SQL-only syntax (TOP, brackets); writes/DDL must parse as PostgreSQL.
    const ts = tryParse(sql, 'transactsql');
    if (ts instanceof Error)
      return unknown(`Could not parse the statement: ${pg.message.slice(0, 200)}`);
    const node = single(ts);
    if (typeof node === 'string') return unknown(node);
    if (!isPlainSelect(node)) return unknown('Only SELECT is recognised in the T-SQL dialect.');
    const tsCtes = scanCtes(node, ts.tableList);
    if (typeof tsCtes === 'string') return unknown(tsCtes);
    if (!actionsAllowed(ts.tableList, ['select'])) {
      return unknown('A SELECT may only read tables.');
    }
    return { kind: 'SELECT', tables: tablesFor(ts.tableList, 'select', tsCtes) };
  }
  const node = single(pg);
  if (typeof node === 'string') return unknown(node);
  const ctes = scanCtes(node, pg.tableList);
  if (typeof ctes === 'string') return unknown(ctes);
  const ownAction = typeof node.type === 'string' ? node.type : '';
  const allowedActions = ownAction === 'select' ? ['select'] : [ownAction, 'select'];
  if (!actionsAllowed(pg.tableList, allowedActions)) {
    return unknown(`A ${ownAction.toUpperCase()} statement may not perform other table actions.`);
  }

  switch (node.type) {
    case 'select':
      if (!isPlainSelect(node)) return unknown('SELECT … INTO / FOR is not allowed.');
      return { kind: 'SELECT', tables: tablesFor(pg.tableList, 'select', ctes) };
    case 'insert':
    case 'update':
    case 'delete': {
      const kind = node.type.toUpperCase() as WriteKind;
      const targets = tablesFor(pg.tableList, node.type, ctes);
      if (targets.length !== 1) return unknown(`${kind} must target exactly one table.`);
      const table = targets[0] as string;
      const result: Classified = {
        kind,
        table,
        hasWhere: kind !== 'INSERT' && !isNil(node.where),
        sourceTables: tablesFor(pg.tableList, 'select', ctes),
      };
      try {
        result.stmt = convertWriteNode(node);
      } catch (err) {
        result.stmtError = err instanceof Error ? err.message : String(err);
      }
      return result;
    }
    case 'create': {
      if (node.keyword !== 'table')
        return unknown(`CREATE ${String(node.keyword)} is not supported.`);
      const tables = Array.isArray(node.table) ? node.table : [];
      const table = tables.length === 1 ? tableName(tables[0]) : undefined;
      if (!table) return unknown('CREATE TABLE must name exactly one unqualified table.');
      return {
        kind: 'CREATE_TABLE',
        table,
        temporary: !isNil(node.temporary) && node.temporary !== '',
        sourceTables: tablesFor(pg.tableList, 'select', ctes),
        ast: node,
      };
    }
    case 'alter': {
      if (!isNil(node.keyword) && node.keyword !== 'table') {
        return unknown(`ALTER ${String(node.keyword)} is not supported.`);
      }
      const tables = Array.isArray(node.table) ? node.table : [];
      const table = tables.length === 1 ? tableName(tables[0]) : undefined;
      if (!table) return unknown('ALTER TABLE must name exactly one unqualified table.');
      return { kind: 'ALTER_TABLE', table, temporary: false, sourceTables: [], ast: node };
    }
    case 'drop': {
      if (node.keyword !== 'table')
        return unknown(`DROP ${String(node.keyword)} is not supported.`);
      const names = Array.isArray(node.name) ? node.name : [];
      const table = names.length === 1 ? tableName(names[0]) : undefined;
      if (!table) return unknown('DROP TABLE must name exactly one unqualified table.');
      return { kind: 'DROP_TABLE', table, temporary: false, sourceTables: [], ast: node };
    }
    default:
      return unknown(`Statement type ${String(node.type)} is not supported.`);
  }
}
