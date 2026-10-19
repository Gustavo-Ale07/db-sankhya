import { tokenize, type Token } from './tokenizer';

/**
 * Fail-closed lexical gate for reads sent to Sankhya. It runs BEFORE the AST
 * allowlist (read-analyzer) and refuses anything that could turn a read into a
 * side effect: comments, extra statements, write/DDL/procedural keywords,
 * package calls, db links and sequences. Keywords are only matched on bare
 * word tokens, so `'DELETE'` (string) and `"INTO"` (quoted identifier) pass.
 */

export type GateResult = { ok: true } | { ok: false; code: 'SQL_FORBIDDEN'; reason: string };

export const DENY_WORDS: ReadonlySet<string> = new Set([
  'INTO',
  'UPDATE',
  'DELETE',
  'INSERT',
  'MERGE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'GRANT',
  'REVOKE',
  'EXEC',
  'EXECUTE',
  'CALL',
  'BEGIN',
  'DECLARE',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'LOCK',
  'WAITFOR',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'NEXTVAL',
  'CURRVAL',
  'SHUTDOWN',
  'KILL',
  'BACKUP',
  'RESTORE',
  'DBCC',
  'RECONFIGURE',
  'USE',
  'SET',
]);

/** Package / system-object prefixes. `SYS.` only matches the dotted form. */
export const DENY_PREFIXES: readonly string[] = [
  'DBMS_',
  'UTL_',
  'XP_',
  'SP_',
  'SYS.',
  'OWA_',
  'CTX_',
];

/**
 * Function-style entries of DENY_WORDS that keep their meaning when quoted
 * (`SEQ."NEXTVAL"`, `"OPENQUERY"(…)`), so they are also refused as identifiers.
 */
export const DENY_QUOTED: ReadonlySet<string> = new Set([
  'NEXTVAL',
  'CURRVAL',
  'OPENQUERY',
  'OPENROWSET',
  'OPENDATASOURCE',
]);

/** Oracle alternative-quoting prefixes (q'[…]', nq'{…}'); the lexer does not model them. */
const ALT_QUOTE_PREFIXES = new Set(['Q', 'NQ']);

const refuse = (reason: string): GateResult => ({ ok: false, code: 'SQL_FORBIDDEN', reason });

function unquote(t: Token): string {
  return t.text.slice(1, -1);
}

function deniedPrefix(name: string, nextIsDot: boolean): string | undefined {
  const upper = name.toUpperCase();
  return DENY_PREFIXES.find((p) =>
    p.endsWith('.') ? nextIsDot && upper === p.slice(0, -1) : upper.startsWith(p),
  );
}

export function tokenGate(sql: string): GateResult {
  const tokens = tokenize(sql, { ansi: true });
  const significant = tokens.filter((t) => t.type !== 'space');
  if (significant.length === 0) return refuse('empty statement');

  for (let idx = 0; idx < significant.length; idx++) {
    const t = significant[idx] as Token;
    const next = significant[idx + 1];
    if (t.unterminated) return refuse(`unterminated ${t.type} at offset ${t.start}`);
    switch (t.type) {
      case 'comment':
        return refuse('comments are not allowed');
      case 'semicolon':
        if (next !== undefined) return refuse('multiple statements are not allowed');
        if (idx === 0) return refuse('empty statement');
        break;
      case 'symbol':
        if (t.text === '@') return refuse('`@` (db link / variable) is not allowed');
        break;
      case 'word': {
        const upper = t.text.toUpperCase();
        // `1EXEC` lexes as number `1E` + word `XEC`, `0x1INTO` as `0` + `x1INTO`:
        // a word glued to a number can smuggle a keyword past the checks below.
        const prev = significant[idx - 1];
        if (prev?.type === 'number' && prev.end === t.start) {
          return refuse(`a number glued to a word is not allowed at offset ${t.start}`);
        }
        if (
          ALT_QUOTE_PREFIXES.has(upper) &&
          next?.type === 'string' &&
          next.start === t.end &&
          next.text.startsWith("'")
        ) {
          return refuse("Oracle alternative quoting (q'…') is not allowed");
        }
        if (DENY_WORDS.has(upper)) return refuse(`keyword ${upper} is not allowed in a read`);
        const prefix = deniedPrefix(t.text, next?.type === 'symbol' && next.text === '.');
        if (prefix) return refuse(`${upper} matches forbidden prefix ${prefix}`);
        break;
      }
      case 'quotedIdent': {
        const name = unquote(t).toUpperCase();
        if (DENY_QUOTED.has(name)) return refuse(`identifier ${t.text} is not allowed in a read`);
        const prefix = deniedPrefix(unquote(t), next?.type === 'symbol' && next.text === '.');
        if (prefix) return refuse(`${t.text} matches forbidden prefix ${prefix}`);
        break;
      }
      default:
        break;
    }
  }
  return { ok: true };
}
