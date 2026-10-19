/**
 * Gate for scratch SQL. A statement is first classified by the SQL engine's AST classifier
 * (`classifyStatement`, PostgreSQL profile); anything it does not positively recognise is
 * refused. The PostgreSQL AST is then checked for denied functions and for every table it
 * touches (all must be lowercase `tmp_*`), and the SQL is regenerated from that AST: the
 * workspace executes the regenerated text, never the raw input, so what runs is what was checked.
 * Every check fails closed.
 */
import { AppError } from '@dbx/shared';
import type { PolicyColumn } from '@dbx/shared';
import { classifyStatement, type Classified } from '@dbx/sql-engine';
import parserPkg from 'node-sql-parser';

const { Parser } = parserPkg;
const parser = new Parser();
const OPTIONS = { database: 'postgresql' };

export const MAX_SCRATCH_SQL_LENGTH = 100_000;

export type ScratchCommand =
  'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE TABLE' | 'ALTER TABLE' | 'DROP TABLE';

/** The permission a scratch statement needs (see the permission catalog in the plan). */
export type ScratchAction = 'QUERY.SELECT' | 'TEMP.CREATE' | 'TEMP.WRITE' | 'TEMP.DROP';

export interface ScratchStatement {
  command: ScratchCommand;
  action: ScratchAction;
  /** The SQL regenerated from the AST; this is what the workspace executes. */
  sql: string;
  /** Scratch tables the statement references (CTE names excluded). */
  tables: string[];
  /** The table written by INSERT/UPDATE/DELETE/CREATE/ALTER/DROP. */
  target: string | null;
  mutating: boolean;
  /**
   * Columns a SELECT reads, for column policy rules (see `selectColumns`). Undefined for every
   * other command: the policy engine then treats each table as `*`, which every column rule hits.
   */
  columns?: PolicyColumn[];
}

/** Scratch tables are always lowercase `tmp_*` identifiers. */
export const SCRATCH_TABLE_NAME = /^tmp_[a-z0-9_]{1,59}$/;

// Deny list from the brief, plus functions that read server state or run a query given as text.
const DENIED_FUNCTION_PREFIXES = ['pg_', 'dblink', 'lo_', 'txid_'];
const DENIED_FUNCTIONS = new Set([
  'copy',
  'loread',
  'lowrite',
  'set_config',
  'current_setting',
  'ts_stat',
  'ts_rewrite',
  'query_to_xml',
  'query_to_xmlschema',
  'query_to_xml_and_xmlschema',
  'cursor_to_xml',
  'cursor_to_xmlschema',
  'table_to_xml',
  'table_to_xmlschema',
  'table_to_xml_and_xmlschema',
  'schema_to_xml',
  'schema_to_xmlschema',
  'schema_to_xml_and_xmlschema',
  'database_to_xml',
  'database_to_xmlschema',
  'database_to_xml_and_xmlschema',
]);

const COMMANDS: Record<
  Exclude<Classified['kind'], 'UNKNOWN'>,
  { command: ScratchCommand; action: ScratchAction }
> = {
  SELECT: { command: 'SELECT', action: 'QUERY.SELECT' },
  INSERT: { command: 'INSERT', action: 'TEMP.WRITE' },
  UPDATE: { command: 'UPDATE', action: 'TEMP.WRITE' },
  DELETE: { command: 'DELETE', action: 'TEMP.WRITE' },
  CREATE_TABLE: { command: 'CREATE TABLE', action: 'TEMP.CREATE' },
  ALTER_TABLE: { command: 'ALTER TABLE', action: 'TEMP.CREATE' },
  DROP_TABLE: { command: 'DROP TABLE', action: 'TEMP.DROP' },
};

type Node = Record<string, unknown>;

const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null;

export function assertScratchTableName(name: string): void {
  if (!SCRATCH_TABLE_NAME.test(name)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Scratch tables must be named tmp_<name> in lowercase (got "${name.slice(0, 64)}").`,
    );
  }
}

export function analyzeScratchSql(input: string): ScratchStatement {
  if (input.length > MAX_SCRATCH_SQL_LENGTH) {
    throw new AppError('QUERY_LIMIT_EXCEEDED', 'The statement is too long.');
  }
  const first = check(input);

  // Execute exactly what was checked: regenerate the SQL from the AST, then check the regenerated
  // text again and require the same statement, so a lossy sqlify cannot smuggle in something else.
  let sql: string;
  try {
    sql = parser.sqlify(first.ast as never, OPTIONS);
  } catch {
    throw new AppError('SQL_UNSUPPORTED', 'The scratch statement is not supported.');
  }
  let second: Checked;
  try {
    second = check(sql);
  } catch {
    throw new AppError('SQL_UNSUPPORTED', 'The scratch statement could not be regenerated safely.');
  }
  if (
    second.command !== first.command ||
    second.target !== first.target ||
    second.tables.join(',') !== first.tables.join(',')
  ) {
    throw new AppError('SQL_UNSUPPORTED', 'The scratch statement could not be regenerated safely.');
  }
  return {
    command: first.command,
    action: first.action,
    sql,
    tables: first.tables,
    target: first.target,
    mutating: first.command !== 'SELECT',
    ...(first.command === 'SELECT' ? { columns: selectColumns(first.ast, first.tables) } : {}),
  };
}

interface Checked {
  command: ScratchCommand;
  action: ScratchAction;
  tables: string[];
  target: string | null;
  ast: Node;
}

function check(input: string): Checked {
  // 1. What is it? The engine's classifier decides; UNKNOWN is refused.
  const classified = classifyStatement(input);
  if (classified.kind === 'UNKNOWN') {
    throw new AppError(
      'SQL_UNSUPPORTED',
      `Scratch accepts one SELECT, INSERT, UPDATE, DELETE or CREATE/ALTER/DROP TABLE: ${classified.reason}`,
    );
  }
  const { command, action } = COMMANDS[classified.kind];

  // 2. The PostgreSQL AST (the classifier may have accepted a T-SQL-only read; scratch is PG).
  let ast: Node;
  let tableList: string[];
  try {
    const parsed = parser.parse(input, OPTIONS);
    const list: unknown[] = Array.isArray(parsed.ast) ? parsed.ast : [parsed.ast];
    if (list.length !== 1 || !isNode(list[0])) throw new Error('not one statement');
    ast = list[0];
    tableList = parsed.tableList;
  } catch {
    throw new AppError('SQL_PARSE_ERROR', 'The scratch statement is not valid PostgreSQL.');
  }
  if (typeof ast.type !== 'string' || commandOfAst(ast) !== command) {
    throw new AppError('SQL_UNSUPPORTED', 'The scratch statement could not be classified.');
  }

  checkNodes(ast);
  checkDdlTargets(ast);

  // 3. Every table the statement touches must be a scratch table.
  const cteNames = collectCteNames(ast);
  const tables = new Set<string>();
  const accept = (name: string) => {
    assertScratchTableName(name);
    tables.add(name);
  };
  for (const entry of tableList) {
    const [, db, table] = entry.split('::');
    if (db !== 'null' || table === undefined) {
      throw new AppError('VALIDATION_ERROR', 'Schema-qualified names are not allowed in scratch.');
    }
    if (!cteNames.has(table)) accept(table);
  }
  for (const ref of tableRefs(ast)) {
    if (ref.qualified) {
      throw new AppError('VALIDATION_ERROR', 'Schema-qualified names are not allowed in scratch.');
    }
    if (!cteNames.has(ref.table)) accept(ref.table);
  }
  let target: string | null = null;
  if (classified.kind === 'SELECT') {
    for (const t of classified.tables) if (!cteNames.has(t)) accept(t);
  } else {
    for (const t of classified.sourceTables) if (!cteNames.has(t)) accept(t);
    target = classified.table;
    accept(target);
  }
  return { command, action, tables: [...tables].sort(), target, ast };
}

/** Cross-check of the classifier against the PostgreSQL AST root. */
function commandOfAst(ast: Node): ScratchCommand | null {
  switch (ast.type) {
    case 'select':
      return 'SELECT';
    case 'insert':
      return 'INSERT';
    case 'update':
      return 'UPDATE';
    case 'delete':
      return 'DELETE';
    case 'create':
      return ast.keyword === 'table' ? 'CREATE TABLE' : null;
    case 'alter':
      return 'ALTER TABLE';
    case 'drop':
      return ast.keyword === 'table' ? 'DROP TABLE' : null;
    default:
      return null;
  }
}

/**
 * Every table-shaped node in the AST (FROM items, targets, RENAME TO, REFERENCES …), so a
 * name the parser's table list misses still has to be a scratch table.
 */
function tableRefs(ast: Node): Array<{ table: string; qualified: boolean }> {
  const out: Array<{ table: string; qualified: boolean }> = [];
  walk(ast, (node) => {
    if (typeof node.table !== 'string' || node.type === 'column_ref' || 'column' in node) return;
    const qualified =
      (node.db !== null && node.db !== undefined) ||
      (node.schema !== null && node.schema !== undefined);
    out.push({ table: node.table, qualified });
  });
  return out;
}

function collectCteNames(ast: Node): Set<string> {
  const names = new Set<string>();
  walk(ast, (node) => {
    if (!Array.isArray(node.with)) return;
    for (const cte of node.with) {
      if (!isNode(cte)) continue;
      const name = cte.name;
      if (typeof name === 'string') names.add(name);
      else if (isNode(name) && typeof name.value === 'string') names.add(name.value);
    }
  });
  return names;
}

/**
 * Columns a SELECT reads, attributed fail closed: a qualifier that is a scratch table or its
 * alias names that table; any other qualifier (a CTE, a derived table) and an unqualified column
 * belong to every table of the statement. A star, and a bare name that is a table, alias, CTE or
 * derived-table name (a whole-row reference such as `row_to_json(t)`), and a NATURAL JOIN read
 * every column: `*`,
 * which every column rule hits (scratch has no catalog to expand it). `COUNT(*)` reads none.
 */
function selectColumns(ast: Node, tables: string[]): PolicyColumn[] {
  const byQualifier = new Map<string, Set<string>>();
  const rowNames = new Set<string>();
  const addQualifier = (q: string, table: string) => {
    const set = byQualifier.get(q.toLowerCase()) ?? new Set<string>();
    set.add(table);
    byQualifier.set(q.toLowerCase(), set);
  };
  for (const cte of collectCteNames(ast)) rowNames.add(cte.toLowerCase());
  const countStars = new Set<Node>();
  walk(ast, (node) => {
    const alias = typeof node.as === 'string' ? node.as : null;
    if (typeof node.table === 'string' && node.type !== 'column_ref' && !('column' in node)) {
      rowNames.add(node.table.toLowerCase());
      if (alias) rowNames.add(alias.toLowerCase());
      if (tables.includes(node.table)) {
        addQualifier(node.table, node.table);
        if (alias) addQualifier(alias, node.table);
      }
    } else if (alias && isNode(node.expr) && 'ast' in node.expr) {
      rowNames.add(alias.toLowerCase());
    }
    if (
      node.type === 'aggr_func' &&
      typeof node.name === 'string' &&
      node.name.toUpperCase() === 'COUNT' &&
      isNode(node.args) &&
      isNode(node.args.expr) &&
      node.args.expr.type === 'star'
    ) {
      countStars.add(node.args.expr);
    }
  });
  const owners = (qualifier: string | null): string[] => {
    const hit = qualifier === null ? undefined : byQualifier.get(qualifier.toLowerCase());
    return hit ? [...hit] : tables;
  };

  const seen = new Set<string>();
  const columns: PolicyColumn[] = [];
  const push = (table: string, name: string) => {
    const key = `${table}\u0000${name.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    columns.push({ table, name });
  };
  walk(ast, (node) => {
    if (node.type === 'star' && !countStars.has(node)) {
      for (const t of tables) push(t, '*');
      return;
    }
    if (typeof node.table === 'string' && node.type !== 'column_ref' && !('column' in node)) {
      // `JOIN … USING (c)` reads `c` on both sides; it is attributed to every table.
      if (Array.isArray(node.using)) {
        for (const u of node.using) {
          const name = identifier(u);
          for (const t of tables) push(t, name ?? '*');
        }
      }
      // NATURAL JOIN compares every common column. The parser reads NATURAL as an alias of the
      // left table and leaves the join without a condition; either sign reads every column.
      const natural = typeof node.as === 'string' && node.as.toLowerCase() === 'natural';
      const bare =
        typeof node.join === 'string' &&
        !/cross/i.test(node.join) &&
        (node.on === null || node.on === undefined) &&
        !Array.isArray(node.using);
      if (natural || bare) for (const t of tables) push(t, '*');
      return;
    }
    if (node.type !== 'column_ref') return;
    const qualifier = identifier(node.table);
    const column =
      identifier(node.column) ?? (isNode(node.column) ? identifier(node.column.expr) : null);
    if (column === null) {
      // A column the parser shaped in a way this does not know: treat it as reading everything.
      for (const t of owners(qualifier)) push(t, '*');
      return;
    }
    const wholeRow = column === '*' || (qualifier === null && rowNames.has(column.toLowerCase()));
    const ownerTables =
      qualifier === null && wholeRow && column !== '*' ? owners(column) : owners(qualifier);
    for (const t of ownerTables) push(t, wholeRow ? '*' : column);
  });
  return columns;
}

/** A plain name, or the `{ type: 'default', value }` form the parser uses for identifiers. */
function identifier(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (
    isNode(v) &&
    typeof v.value === 'string' &&
    (v.type === 'default' ||
      v.type === 'backticks_quote_string' ||
      v.type === 'double_quote_string')
  )
    return v.value;
  return null;
}

const PLAIN_ALIAS = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$$/;

/**
 * Denied functions, plus nodes the regenerated SQL cannot represent faithfully: bind parameters
 * and variables (`:x`, `$1`, `@x`, `@@version`) and table aliases that are not plain identifiers
 * (`tmp_a t(pg_sleep)` parses as alias "t(pg_sleep)").
 */
function checkNodes(ast: Node): void {
  walk(ast, (node) => {
    // The parser represents dollar-quoted strings ($$..$$, $tag$..$tag$) as `var` too; those are
    // literals and stay allowed.
    const dollarQuoted =
      node.type === 'var' &&
      typeof node.prefix === 'string' &&
      DOLLAR_QUOTE.test(node.prefix) &&
      node.suffix === node.prefix;
    if (node.type === 'param' || (node.type === 'var' && !dollarQuoted)) {
      throw new AppError(
        'SQL_UNSUPPORTED',
        'Parameters and variables are not supported in scratch; write the value inline.',
      );
    }
    if (
      typeof node.table === 'string' &&
      node.type !== 'column_ref' &&
      !('column' in node) &&
      node.as !== null &&
      node.as !== undefined &&
      (typeof node.as !== 'string' || !PLAIN_ALIAS.test(node.as))
    ) {
      throw new AppError('SQL_UNSUPPORTED', 'Table aliases must be plain identifiers in scratch.');
    }
    if (node.type !== 'function') return;
    const parts = nameParts(node.name);
    if (parts.length !== 1) {
      throw new AppError('SQL_FORBIDDEN', 'Schema-qualified function calls are not allowed.');
    }
    const name = parts[0]!.toLowerCase();
    if (DENIED_FUNCTIONS.has(name) || DENIED_FUNCTION_PREFIXES.some((p) => name.startsWith(p))) {
      throw new AppError('SQL_FORBIDDEN', `The function ${name} is not allowed in scratch.`);
    }
  });
}

/**
 * DDL targets never carry an alias. The parser reads `DROP TABLE tmp_a CASCADE` (or RESTRICT) as
 * an alias, which sqlify would turn into something else, so any alias there is refused.
 */
function checkDdlTargets(ast: Node): void {
  const targets =
    ast.type === 'drop' ? ast.name : ast.type === 'create' || ast.type === 'alter' ? ast.table : [];
  for (const t of Array.isArray(targets) ? targets : [targets]) {
    if (isNode(t) && t.as !== null && t.as !== undefined) {
      throw new AppError(
        'SQL_UNSUPPORTED',
        'CASCADE, RESTRICT and aliases are not supported on scratch DDL targets.',
      );
    }
  }
}

function nameParts(name: unknown): string[] {
  if (typeof name === 'string') return [name];
  if (!isNode(name)) return [];
  const parts: string[] = [];
  if (isNode(name.schema) && typeof name.schema.value === 'string') parts.push(name.schema.value);
  if (Array.isArray(name.name)) {
    for (const part of name.name) {
      if (isNode(part) && typeof part.value === 'string') parts.push(part.value);
    }
  }
  return parts;
}

function walk(node: unknown, visit: (n: Node) => void, depth = 0): void {
  if (depth > 200)
    throw new AppError('QUERY_LIMIT_EXCEEDED', 'The statement is too deeply nested.');
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, depth + 1);
    return;
  }
  if (!isNode(node)) return;
  visit(node);
  for (const value of Object.values(node)) walk(value, visit, depth + 1);
}
