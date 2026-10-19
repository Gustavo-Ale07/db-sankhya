/**
 * Read-only gate for the mock's `DbExplorerSP.executeQuery`, so the mock can never become a write
 * path. It mirrors the deny rules of the application's token gate (audit §3.4): one statement,
 * no comments, SELECT/WITH only, and no write or side-effect keywords outside string literals.
 * The mock additionally runs every query inside a READ ONLY transaction.
 */

const DENY_WORDS = new Set([
  'INTO',
  'NEXTVAL',
  'CURRVAL',
  'EXEC',
  'EXECUTE',
  'CALL',
  'BEGIN',
  'DECLARE',
  'MERGE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'GRANT',
  'REVOKE',
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'COMMIT',
  'ROLLBACK',
  'LOCK',
  'WAITFOR',
  'OPENROWSET',
  'OPENQUERY',
  'COPY',
  'SET',
  'DO',
  'LISTEN',
  'NOTIFY',
  'VACUUM',
]);
const DENY_PREFIXES = ['XP_', 'SP_', 'DBMS_', 'UTL_', 'PG_'];

export type GateResult = { ok: true } | { ok: false; reason: string };

export function gateMockQuery(sql: string): GateResult {
  const words: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const end = closeQuote(sql, i, ch);
      if (end < 0) return { ok: false, reason: 'Unterminated literal.' };
      const inner = sql.slice(i + 1, end - 1).toUpperCase();
      if (ch === '"' && DENY_PREFIXES.some((p) => inner.startsWith(p))) {
        return { ok: false, reason: `Identifier ${inner} is not accepted.` };
      }
      i = end;
      continue;
    }
    if ((ch === '-' && sql[i + 1] === '-') || (ch === '/' && sql[i + 1] === '*')) {
      return { ok: false, reason: 'Comments are not accepted.' };
    }
    if (ch === ';') {
      if (sql.slice(i + 1).trim() !== '') return { ok: false, reason: 'Only one statement.' };
      i += 1;
      continue;
    }
    if (ch === '@' || ch === '$' || ch === '\\') {
      return { ok: false, reason: `Character ${ch} is not accepted.` };
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
      words.push(sql.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    i += 1;
  }
  const first = words[0];
  if (first !== 'SELECT' && first !== 'WITH') {
    return { ok: false, reason: 'Only SELECT statements are accepted.' };
  }
  for (const w of words) {
    if (DENY_WORDS.has(w)) return { ok: false, reason: `Keyword ${w} is not accepted.` };
    if (DENY_PREFIXES.some((p) => w.startsWith(p))) {
      return { ok: false, reason: `Identifier ${w} is not accepted.` };
    }
  }
  if (/\bFOR\s+(UPDATE|SHARE)\b/i.test(stripLiterals(sql))) {
    return { ok: false, reason: 'Row locking is not accepted.' };
  }
  return { ok: true };
}

function closeQuote(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return -1;
}

function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
}
