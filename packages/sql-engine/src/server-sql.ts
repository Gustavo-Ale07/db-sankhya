/**
 * Server-side execution routing and wrapping for the "Executa Banco" path.
 *
 * This module is PURE and side-effect free: it decides which SERVER.* category a
 * statement belongs to and builds the PL/SQL block that the server-side DBScript
 * action runs. It never decides whether the server-side path is *allowed* — that
 * is the master switch (SERVER_SQL_ENABLED), the environment gate (HOMOLOGATION /
 * SANDBOX only), the RBAC permission and the policy engine, all evaluated by the
 * caller. Routing here is best-effort; safety is enforced by those gates plus the
 * mandatory confirmation.
 *
 * The categories mirror the SERVER.* permissions:
 *  - DDL      CREATE / ALTER / DROP / TRUNCATE / RENAME / COMMENT (any object)
 *  - DELETE   generic DELETE (no documented gateway service exists)
 *  - DML_RAW  MERGE, INSERT … SELECT, UPDATE with subquery/expression
 *  - DCL      GRANT / REVOKE
 *  - PLSQL    anonymous block (BEGIN/DECLARE) or a procedure call (EXEC/CALL)
 */
import { AppError } from '@dbx/shared';
import { tokenize, type Token } from './tokenizer';

/**
 * Rejects a payload that smuggles more than one statement, so the category — and the
 * SERVER.* permission and policy decision keyed on it — can never be confused by a
 * trailing `; DROP TABLE …` riding behind a statement classified as, say, DELETE.
 * Semicolons inside strings, quoted identifiers and comments do not count (the ansi
 * lexer consumes them); a single trailing terminator is fine. PL/SQL is exempt: a block
 * legitimately holds many statements, and SERVER.PLSQL already authorizes an arbitrary
 * block, so there is no category to confuse.
 */
function assertSingleStatement(sql: string): void {
  const tokens = tokenize(sql, { ansi: true });
  let lastContentIndex = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.type !== 'space' && t.type !== 'comment' && t.type !== 'semicolon') lastContentIndex = i;
  }
  for (let i = 0; i < lastContentIndex; i++) {
    if ((tokens[i] as Token).type === 'semicolon') {
      throw new AppError(
        'SERVER_SQL_UNSUPPORTED',
        'Multiple statements are not allowed on the server-side route; send one statement at a time.',
      );
    }
  }
}

export const SERVER_SQL_CATEGORIES = [
  'DDL',
  'DELETE',
  'DML_RAW',
  'DCL',
  'PLSQL',
  'UNSUPPORTED',
] as const;
export type ServerSqlCategory = (typeof SERVER_SQL_CATEGORIES)[number];

export interface ServerSqlClassification {
  category: ServerSqlCategory;
  reason: string;
}

/**
 * The switches that gate the server-side path. Every one fails closed. This is the only place
 * that decides whether the path may run at all; routing and wrapping assume it has passed.
 */
export interface ServerSqlGate {
  /** Master switch SERVER_SQL_ENABLED — off by default. */
  serverSqlEnabled: boolean;
  globalWriteEnabled: boolean;
  writeToSankhya: boolean;
  safeMode: boolean;
  /** Explicit, separate opt-in required before the path may run against PRODUCTION. */
  productionOptIn: boolean;
}

type ServerEnvironment = 'PRODUCTION' | 'HOMOLOGATION' | 'SANDBOX';

/**
 * Fail-closed gate for the server-side ("Executa Banco") path. Throws an AppError with a
 * switch-specific code when the path may not run. PRODUCTION needs a separate explicit opt-in
 * and is still blocked under SAFE_MODE; it starts life allowed only in HOMOLOGATION / SANDBOX.
 */
export function assertServerSqlAllowed(gate: ServerSqlGate, environment: ServerEnvironment): void {
  if (!gate.serverSqlEnabled) {
    throw new AppError(
      'SERVER_SQL_DISABLED',
      'Server-side SQL execution is disabled (SERVER_SQL_ENABLED).',
      {
        switch: 'SERVER_SQL_ENABLED',
      },
    );
  }
  if (!gate.globalWriteEnabled) {
    throw new AppError('READ_ONLY_MODE', 'Writes are disabled (GLOBAL_WRITE_ENABLED).', {
      switch: 'GLOBAL_WRITE_ENABLED',
    });
  }
  if (!gate.writeToSankhya) {
    throw new AppError('READ_ONLY_MODE', 'Writes are disabled (WRITE_TO_SANKHYA).', {
      switch: 'WRITE_TO_SANKHYA',
    });
  }
  if (environment === 'PRODUCTION' && (!gate.productionOptIn || gate.safeMode)) {
    throw new AppError(
      'SERVER_SQL_PRODUCTION_BLOCKED',
      'Server-side SQL is blocked against PRODUCTION: it needs a separate explicit opt-in and SAFE_MODE off.',
      { switch: gate.safeMode ? 'SAFE_MODE' : 'SERVER_SQL_PRODUCTION_OPT_IN' },
    );
  }
}

/** Raw DML/DELETE: run through EXECUTE IMMEDIATE so Oracle executes exactly one statement. */
const DIRECT_DML = new Set<ServerSqlCategory>(['DELETE', 'DML_RAW']);
/** DDL/DCL: not valid as a direct block statement, so also run through EXECUTE IMMEDIATE. */
const DYNAMIC = new Set<ServerSqlCategory>(['DDL', 'DCL']);

const LEADING: Record<string, ServerSqlCategory> = {
  CREATE: 'DDL',
  ALTER: 'DDL',
  DROP: 'DDL',
  TRUNCATE: 'DDL',
  RENAME: 'DDL',
  COMMENT: 'DDL',
  DELETE: 'DELETE',
  MERGE: 'DML_RAW',
  INSERT: 'DML_RAW',
  UPDATE: 'DML_RAW',
  GRANT: 'DCL',
  REVOKE: 'DCL',
  BEGIN: 'PLSQL',
  DECLARE: 'PLSQL',
  CALL: 'PLSQL',
  EXEC: 'PLSQL',
  EXECUTE: 'PLSQL',
};

/** First significant word token (skips whitespace and comments). */
function leadingWord(sql: string): string | undefined {
  const tokens = tokenize(sql, { ansi: true });
  const first = tokens.find((t: Token) => t.type !== 'space' && t.type !== 'comment');
  return first?.type === 'word' ? first.text.toUpperCase() : undefined;
}

/**
 * Best-effort routing of a statement the gateway cannot run to its SERVER.* category.
 * SELECT, an empty statement and anything unrecognised are UNSUPPORTED: the caller must
 * never send them server-side.
 */
export function classifyServerSql(sql: string): ServerSqlClassification {
  const word = leadingWord(sql);
  if (!word) return { category: 'UNSUPPORTED', reason: 'No leading SQL keyword.' };
  const category = LEADING[word];
  if (!category) return { category: 'UNSUPPORTED', reason: `${word} has no server-side route.` };
  return { category, reason: `Leading keyword ${word}.` };
}

/** Object keywords that follow a DDL verb and precede the object name. */
const OBJECT_KEYWORDS = new Set(['TABLE', 'VIEW', 'INDEX', 'SEQUENCE', 'SYNONYM', 'TRIGGER']);
/** Modifiers that may sit between CREATE and the object keyword. */
const CREATE_MODIFIERS = new Set(['GLOBAL', 'TEMPORARY', 'TEMP', 'UNIQUE', 'BITMAP', 'PUBLIC']);

/** A token that can begin a (possibly schema-qualified) object name. */
function isNameStart(t: Token | undefined): boolean {
  return !!t && (t.type === 'word' || (t.type === 'quotedIdent' && !t.unterminated));
}

/** The unquoted, upper-cased text of a word or quoted-identifier token. */
function identText(t: Token): string {
  if (t.type === 'quotedIdent') {
    const close = t.text[t.text.length - 1] ?? '';
    const inner = t.text.slice(1, -1);
    // Oracle/SQL-Server double the closing quote to escape it inside "…"; [...] does not.
    return (close === '"' ? inner.split('""').join('"') : inner).toUpperCase();
  }
  return t.text.toUpperCase();
}

/**
 * Reads a possibly schema-qualified, possibly quoted name (`a`, `a.b`, `"S"."T"`) starting at
 * `i`, returning its segments uppercased, or null when `i` is not a name.
 */
function readPath(sig: Token[], i: number): string[] | null {
  if (!isNameStart(sig[i])) return null;
  const segs = [identText(sig[i] as Token)];
  let j = i + 1;
  while (sig[j]?.type === 'symbol' && (sig[j] as Token).text === '.' && isNameStart(sig[j + 1])) {
    segs.push(identText(sig[j + 1] as Token));
    j += 2;
  }
  return segs;
}

/** The object (last) segment of a name at `i`: `SANKHYA.TGFPAR` → `TGFPAR`. */
function readObjectName(sig: Token[], i: number): string | null {
  const p = readPath(sig, i);
  return p ? (p[p.length - 1] as string) : null;
}

/**
 * The object a server-side statement acts on, for the policy entity and the audit, parsed with the
 * real tokenizer (strings, comments and quoted / schema-qualified identifiers handled). Returns the
 * object's final segment uppercased, or **null when it cannot be determined reliably** — the caller
 * must then fail closed rather than guess, so a DDL/DELETE/DML_RAW/DCL is never authorized against
 * the wrong entity. PL/SQL has no single target by design and resolves to null here.
 */
export function serverSqlTarget(sql: string): string | null {
  const sig = tokenize(sql, { ansi: true }).filter(
    (t: Token) => t.type !== 'space' && t.type !== 'comment',
  );
  const word = (i: number): string | undefined =>
    sig[i]?.type === 'word' ? (sig[i] as Token).text.toUpperCase() : undefined;
  const lead = word(0);
  if (!lead) return null;

  // GRANT/REVOKE … ON [TABLE] <obj> …; CREATE INDEX … ON <table>.
  const afterOn = (): string | null => {
    const onIdx = sig.findIndex(
      (t, k) => k > 0 && t.type === 'word' && t.text.toUpperCase() === 'ON',
    );
    if (onIdx < 0) return null;
    let i = onIdx + 1;
    if (word(i) === 'TABLE') i += 1;
    return readObjectName(sig, i);
  };

  switch (lead) {
    case 'MERGE':
      return word(1) === 'INTO' ? readObjectName(sig, 2) : null;
    case 'INSERT':
      return word(1) === 'INTO' ? readObjectName(sig, 2) : null;
    case 'DELETE':
      return word(1) === 'FROM' ? readObjectName(sig, 2) : null;
    case 'UPDATE':
      return readObjectName(sig, 1);
    case 'TRUNCATE':
      return word(1) === 'TABLE' ? readObjectName(sig, 2) : null;
    case 'RENAME':
      return readObjectName(sig, 1);
    case 'ALTER':
      return OBJECT_KEYWORDS.has(word(1) ?? '') ? readObjectName(sig, 2) : null;
    case 'DROP': {
      if (!OBJECT_KEYWORDS.has(word(1) ?? '')) return null;
      let i = 2;
      if (word(i) === 'IF' && word(i + 1) === 'EXISTS') i += 2;
      return readObjectName(sig, i);
    }
    case 'CREATE': {
      let i = 1;
      if (word(i) === 'OR' && word(i + 1) === 'REPLACE') i += 2;
      while (word(i) && CREATE_MODIFIERS.has(word(i) as string)) i += 1;
      const kind = word(i);
      if (!OBJECT_KEYWORDS.has(kind ?? '')) return null;
      i += 1;
      // CREATE INDEX <idx> ON <table>: the affected base object is the table, not the index name.
      if (kind === 'INDEX') return afterOn();
      // CREATE VIEW/SYNONYM/TRIGGER name a NEW object that references (or fires on) other objects,
      // so the created name is NOT the affected base entity. Pinning policy to it would authorize a
      // statement that actually touches a different table, so fail closed here (the caller refuses
      // an undetermined target). TABLE/SEQUENCE are their own target and stay determinable. (DROP /
      // ALTER of these objects still resolve to the named object itself — only CREATE indirects.)
      if (kind === 'VIEW' || kind === 'SYNONYM' || kind === 'TRIGGER') return null;
      if (word(i) === 'IF' && word(i + 1) === 'NOT' && word(i + 2) === 'EXISTS') i += 3;
      return readObjectName(sig, i);
    }
    case 'COMMENT': {
      if (word(1) !== 'ON') return null;
      let i = 2;
      if (word(i) === 'TABLE') {
        i += 1;
        return readObjectName(sig, i);
      }
      if (word(i) === 'COLUMN') {
        i += 1;
        // A column reference is table.column (optionally schema.table.column): the owning table is
        // the second-to-last segment.
        const p = readPath(sig, i);
        if (!p) return null;
        return (p.length >= 2 ? p[p.length - 2] : p[p.length - 1]) ?? null;
      }
      return null;
    }
    case 'GRANT':
    case 'REVOKE':
      return afterOn();
    default:
      return null;
  }
}

/**
 * Whether a server-side statement is a verb that REQUIRES a `WHERE` (UPDATE / DELETE) and whether it
 * actually carries one at the top level — both decided by the real tokenizer, NOT the PG classifier
 * (which returns UNKNOWN for Oracle DML the gateway cannot parse and would then skip the guard
 * entirely, letting an unqualified `DELETE FROM t` through). A `WHERE` inside a subquery (parenthesised)
 * does not satisfy the statement's own `WHERE`. Fail closed: a verb we cannot read, or an UPDATE/DELETE
 * whose top-level `WHERE` is absent, reports `present: false`.
 */
export function serverSqlWhere(sql: string): { required: boolean; present: boolean } {
  const verb = leadingWord(sql);
  const required = verb === 'UPDATE' || verb === 'DELETE';
  if (!required) return { required: false, present: true };
  const sig = tokenize(sql, { ansi: true }).filter(
    (t: Token) => t.type !== 'space' && t.type !== 'comment',
  );
  let depth = 0;
  for (const t of sig) {
    if (t.type === 'symbol' && t.text === '(') depth += 1;
    else if (t.type === 'symbol' && t.text === ')') depth = Math.max(0, depth - 1);
    else if (t.type === 'word' && depth === 0 && t.text.toUpperCase() === 'WHERE')
      return { required, present: true };
  }
  return { required, present: false };
}

/** Oracle's canonical single-row dummy table: reading it discloses nothing, never policy-governed. */
const READ_IGNORED_SOURCES = new Set(['DUAL']);

/**
 * Keywords that END a table reference inside a FROM list: a clause boundary, a set operator, or a
 * join keyword (the joined table is reached by the main walk through its own JOIN keyword). A word
 * here is never swallowed as a table alias, so a comma-separated sibling after it is still read.
 */
const FROM_LIST_TERMINATORS = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'ORDER',
  'CONNECT',
  'START',
  'MODEL',
  'RETURNING',
  'SET',
  'WHEN',
  'PIVOT',
  'UNPIVOT',
  'FETCH',
  'OFFSET',
  'FOR',
  'INTO',
  'UNION',
  'INTERSECT',
  'MINUS',
  'EXCEPT',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'OUTER',
  'LATERAL',
  'APPLY',
  'ON',
  'USING',
]);

/** Index just after the `)` matching the `(` at `open`, or -1 when the parens are unbalanced. */
function skipParens(sig: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < sig.length; k++) {
    const tk = sig[k] as Token;
    if (tk.type === 'symbol' && tk.text === '(') depth += 1;
    else if (tk.type === 'symbol' && tk.text === ')') {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/**
 * Every table a server-side statement READS from — `FROM` / `JOIN` clauses at any nesting, plus a
 * `MERGE ... USING` source — parsed with the real tokenizer. The caller evaluates the read policy
 * (`QUERY.SELECT`) on each so a write cannot exfiltrate from, or act on, a table the user may not
 * read (`INSERT INTO ok SELECT * FROM secret`, `MERGE INTO ok USING secret`, a `DELETE`/`UPDATE`
 * whose `WHERE` subquery reads `secret`). Returns the set of object segments (uppercased), or
 * **null when a read construct is present but its source cannot be determined** (a function source,
 * an unreadable token) — the caller must then fail closed. A statement that reads nothing returns an
 * empty set. `USING` counts as a source only in `MERGE` (elsewhere it is a join column list or a DDL
 * storage clause, never a read); a `FROM`/`JOIN` immediately followed by `(` is a subquery whose own
 * inner `FROM` this same walk reaches. `DUAL` and the write target are excluded (here and by the caller).
 */
export function serverSqlSources(sql: string): Set<string> | null {
  const sig = tokenize(sql, { ansi: true }).filter(
    (t: Token) => t.type !== 'space' && t.type !== 'comment',
  );
  const usingIsSource = leadingWord(sql) === 'MERGE';
  const isSym = (i: number, ch: string): boolean =>
    sig[i]?.type === 'symbol' && (sig[i] as Token).text === ch;
  const isWord = (i: number, w: string): boolean =>
    sig[i]?.type === 'word' && (sig[i] as Token).text.toUpperCase() === w;
  const sources = new Set<string>();
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i] as Token;
    if (t.type !== 'word') continue;
    const w = t.text.toUpperCase();
    if (w !== 'FROM' && w !== 'JOIN' && !(w === 'USING' && usingIsSource)) continue;
    // Walk the whole comma-separated table list that follows (old-style joins list several, e.g.
    // `FROM A, SECRET`). Stopping at the first name would let every sibling escape read-policy
    // evaluation. Fail closed (null) on anything in the list that is not a plain, nameable table.
    let k = i + 1;
    for (;;) {
      if (isSym(k, '(')) {
        // A derived table / subquery: its own FROM is reached by this same outer walk, so skip the
        // parenthesised block here (without losing a sibling that may follow the closing paren).
        k = skipParens(sig, k);
        if (k < 0) return null;
      } else {
        const path = readPath(sig, k);
        if (!path) return null; // a read construct with an undeterminable source → fail closed
        k += path.length * 2 - 1;
        if (isSym(k, '(')) return null; // `name(` is a table function, not a nameable table
        if (isSym(k, '@')) return null; // `name@dblink` is a remote source → fail closed
        const name = path[path.length - 1] as string;
        if (!READ_IGNORED_SOURCES.has(name)) sources.add(name);
        // Optional Oracle partition / subpartition suffix: `PARTITION (p)` / `SUBPARTITION (p)`.
        while (isWord(k, 'PARTITION') || isWord(k, 'SUBPARTITION')) {
          k += 1;
          if (!isSym(k, '(')) return null;
          k = skipParens(sig, k);
          if (k < 0) return null;
        }
      }
      // Optional alias: `AS <ident>` or a bare identifier that is not a clause/join keyword.
      if (isWord(k, 'AS')) {
        if (!isNameStart(sig[k + 1])) return null;
        k += 2;
      } else if (
        sig[k]?.type === 'word' &&
        !FROM_LIST_TERMINATORS.has((sig[k] as Token).text.toUpperCase())
      ) {
        k += 1;
      }
      // A comma continues the table list; anything else ends this FROM/JOIN/USING clause.
      if (isSym(k, ',')) {
        k += 1;
        continue;
      }
      break;
    }
  }
  return sources;
}

/** Removes trailing whitespace and semicolons, so exactly one terminator can be re-added. */
function stripTrailingSemicolons(sql: string): string {
  return sql.replace(/[\s;]+$/u, '');
}

const Q_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['(', ')'],
];

/**
 * Wraps a payload in `EXECUTE IMMEDIATE q'X…X'`, choosing a delimiter the text cannot close. Used
 * for DDL/DCL (invalid as a direct block statement) AND for raw DML/DELETE: running the statement
 * as a single dynamic-SQL string makes Oracle execute EXACTLY ONE statement regardless of any
 * parser differential between our tokenizer and the database — a `;`-smuggled second statement (or
 * a character the server-side lexer reads differently) becomes an ORA error, never a second command
 * under the first one's category/permission.
 */
function dynamicWrap(payload: string): string {
  const inner = stripTrailingSemicolons(payload);
  for (const [open, close] of Q_DELIMITERS) {
    if (!inner.includes(`${close}'`)) {
      return `BEGIN\nEXECUTE IMMEDIATE q'${open}${inner}${close}';\nEND;`;
    }
  }
  throw new AppError(
    'SERVER_SQL_UNWRAPPABLE',
    'The statement text closes every available q-quote delimiter and cannot be wrapped safely.',
  );
}

/**
 * Builds the PL/SQL block for the server-side action. DDL, DCL and raw DML/DELETE all go through
 * EXECUTE IMMEDIATE so Oracle parses the payload as a single dynamic-SQL string and runs exactly one
 * statement (see `dynamicWrap`); a PL/SQL block passes through, and a bare procedure call is
 * wrapped. UNSUPPORTED is refused.
 */
export function wrapServerSql(sql: string, category: ServerSqlCategory): string {
  if (category === 'UNSUPPORTED') {
    throw new AppError('SERVER_SQL_UNSUPPORTED', 'This statement has no server-side route.');
  }
  // Single-statement categories carry exactly one statement: a second one riding behind a `;`
  // would run under the first one's category/permission. `assertSingleStatement` gives a clean
  // early error for the obvious `a; b` case; `dynamicWrap` (EXECUTE IMMEDIATE) is the structural
  // guarantee that the database executes only one statement even if our lexer and Oracle's differ.
  // PL/SQL is intentionally exempt (a block legitimately holds many statements and SERVER.PLSQL
  // already authorizes an arbitrary one).
  if (DYNAMIC.has(category) || DIRECT_DML.has(category)) {
    assertSingleStatement(sql);
    return dynamicWrap(sql);
  }
  // PLSQL: an anonymous block is already a complete block; anything else is a call to wrap.
  const trimmed = sql.trim();
  const word = leadingWord(trimmed);
  if (word === 'BEGIN' || word === 'DECLARE') return trimmed;
  return `BEGIN\n${stripTrailingSemicolons(trimmed)};\nEND;`;
}
