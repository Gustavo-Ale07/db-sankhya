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

/** Categories wrapped verbatim as DML inside the block (statement + one `;`). */
const DIRECT_DML = new Set<ServerSqlCategory>(['DELETE', 'DML_RAW']);
/** Categories run through EXECUTE IMMEDIATE (DDL/DCL are not valid inside a plain block). */
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

/** Wraps a DDL/DCL payload in `EXECUTE IMMEDIATE q'X…X'`, choosing a delimiter the text cannot close. */
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
 * Builds the PL/SQL block for the server-side action. DML goes straight into the block;
 * DDL/DCL go through EXECUTE IMMEDIATE (invalid as a direct block statement); a PL/SQL block
 * passes through, and a bare procedure call is wrapped. UNSUPPORTED is refused.
 */
export function wrapServerSql(sql: string, category: ServerSqlCategory): string {
  if (category === 'UNSUPPORTED') {
    throw new AppError('SERVER_SQL_UNSUPPORTED', 'This statement has no server-side route.');
  }
  // Single-statement categories carry exactly one statement: a second one riding behind a
  // `;` would run under the first one's category/permission. PL/SQL is intentionally exempt.
  if (DYNAMIC.has(category) || DIRECT_DML.has(category)) assertSingleStatement(sql);
  if (DYNAMIC.has(category)) return dynamicWrap(sql);
  if (DIRECT_DML.has(category)) {
    return `BEGIN\n${stripTrailingSemicolons(sql)};\nEND;`;
  }
  // PLSQL: an anonymous block is already a complete block; anything else is a call to wrap.
  const trimmed = sql.trim();
  const word = leadingWord(trimmed);
  if (word === 'BEGIN' || word === 'DECLARE') return trimmed;
  return `BEGIN\n${stripTrailingSemicolons(trimmed)};\nEND;`;
}
