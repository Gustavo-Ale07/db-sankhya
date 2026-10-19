/**
 * Minimal SQL lexer. It is NOT the parser: it only recognises enough structure
 * (strings, comments, quoted identifiers) to split statements safely, find the
 * leading keyword and handle the trivial SHOW / DESCRIBE / EXPLAIN prefixes.
 */

export type TokenType =
  'word' | 'string' | 'quotedIdent' | 'number' | 'symbol' | 'semicolon' | 'comment' | 'space';

export interface Token {
  type: TokenType;
  text: string;
  start: number;
  end: number;
  /** For strings, comments and quoted identifiers that never close. */
  unterminated?: boolean;
}

const WORD_START = /[A-Za-z_]/;
const WORD_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;

/**
 * Lexing dialect. The default (MySQL-style) treats `"` as a string, backtick as
 * a quoted identifier, `#` as a comment and backslash as an escape. `ansi`
 * matches Oracle / SQL Server: `"…"` and `[…]` are identifiers, `N'…'` is a
 * string, backslash is literal and `#` is a plain symbol.
 */
export interface TokenizeOptions {
  ansi?: boolean;
}

function readQuoted(
  sql: string,
  start: number,
  quote: string,
  close: string = quote,
  backslashEscapes = true,
): { end: number; unterminated: boolean } {
  let i = start + 1;
  while (i < sql.length) {
    const ch = sql[i];
    if (backslashEscapes && ch === '\\' && quote !== '`') {
      i += 2;
      continue;
    }
    if (ch === close) {
      if (sql[i + 1] === close) {
        i += 2;
        continue;
      }
      return { end: i + 1, unterminated: false };
    }
    i++;
  }
  return { end: sql.length, unterminated: true };
}

export function tokenize(sql: string, options: TokenizeOptions = {}): Token[] {
  const ansi = options.ansi === true;
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const start = i;
    if (/\s/.test(ch)) {
      while (i < sql.length && /\s/.test(sql[i] as string)) i++;
      tokens.push({ type: 'space', text: sql.slice(start, i), start, end: i });
    } else if ((ch === '-' && sql[i + 1] === '-') || (ch === '#' && !ansi)) {
      while (i < sql.length && sql[i] !== '\n') i++;
      tokens.push({ type: 'comment', text: sql.slice(start, i), start, end: i });
    } else if (ch === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? sql.length : close + 2;
      tokens.push({
        type: 'comment',
        text: sql.slice(start, i),
        start,
        end: i,
        ...(close === -1 ? { unterminated: true } : {}),
      });
    } else if (ansi && (ch === "'" || ((ch === 'N' || ch === 'n') && sql[i + 1] === "'"))) {
      const { end, unterminated } = readQuoted(sql, ch === "'" ? i : i + 1, "'", "'", false);
      i = end;
      tokens.push({
        type: 'string',
        text: sql.slice(start, i),
        start,
        end: i,
        ...(unterminated ? { unterminated: true } : {}),
      });
    } else if (ansi && (ch === '"' || ch === '[')) {
      const { end, unterminated } = readQuoted(sql, i, ch, ch === '[' ? ']' : '"', false);
      i = end;
      tokens.push({
        type: 'quotedIdent',
        text: sql.slice(start, i),
        start,
        end: i,
        ...(unterminated ? { unterminated: true } : {}),
      });
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const { end, unterminated } = readQuoted(sql, i, ch);
      i = end;
      tokens.push({
        type: ch === '`' ? 'quotedIdent' : 'string',
        text: sql.slice(start, i),
        start,
        end: i,
        ...(unterminated ? { unterminated: true } : {}),
      });
    } else if (DIGIT.test(ch) || (ch === '.' && DIGIT.test(sql[i + 1] ?? ''))) {
      while (i < sql.length && /[0-9.eE]/.test(sql[i] as string)) i++;
      tokens.push({ type: 'number', text: sql.slice(start, i), start, end: i });
    } else if (WORD_START.test(ch)) {
      while (i < sql.length && WORD_PART.test(sql[i] as string)) i++;
      tokens.push({ type: 'word', text: sql.slice(start, i), start, end: i });
    } else if (ch === ';') {
      i++;
      tokens.push({ type: 'semicolon', text: ';', start, end: i });
    } else {
      i++;
      tokens.push({ type: 'symbol', text: ch, start, end: i });
    }
  }
  return tokens;
}

export const isSignificant = (t: Token): boolean => t.type !== 'space' && t.type !== 'comment';

export interface StatementRange {
  text: string;
  start: number;
  end: number;
}

/** Splits a script on top-level semicolons, ignoring empty / comment-only pieces. */
export function splitStatements(sql: string): StatementRange[] {
  const out: StatementRange[] = [];
  let pieceStart = 0;
  let hasContent = false;
  const flush = (end: number) => {
    if (hasContent) {
      const raw = sql.slice(pieceStart, end);
      const lead = raw.length - raw.trimStart().length;
      out.push({
        text: raw.trim(),
        start: pieceStart + lead,
        end: pieceStart + lead + raw.trim().length,
      });
    }
    hasContent = false;
  };
  for (const tok of tokenize(sql)) {
    if (tok.type === 'semicolon') {
      flush(tok.start);
      pieceStart = tok.end;
    } else if (isSignificant(tok)) {
      hasContent = true;
    }
  }
  flush(sql.length);
  return out;
}

/** Returns the statement that contains (or ends right before) the given offset. */
export function statementAt(sql: string, offset: number): StatementRange | undefined {
  const ranges = splitStatements(sql);
  return (
    ranges.find((r) => offset >= r.start && offset <= r.end + 1) ??
    ranges.findLast((r) => r.end <= offset)
  );
}
