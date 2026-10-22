/**
 * Decomposition of a hybrid read: a SELECT that reads both Sankhya tables and the caller's scratch
 * (`tmp_*`) tables. Every parenthesized subquery (a CTE body, a derived table, an IN / EXISTS
 * subquery) that reads only Sankhya tables is a Sankhya part: the caller runs it through the
 * normal read path, copies its rows into a scratch table and the statement is rewritten to read
 * that table instead. Whatever is left must read scratch tables only (the scratch guard checks
 * it). Purely lexical on purpose: the parts keep the exact text the user wrote, so the Sankhya
 * read path judges what the user wrote, not a regenerated version of it.
 */
import { classifyStatement } from './classify';
import { isSignificant, tokenize } from './tokenizer';

export interface HybridPart {
  /** The subquery text, exactly as written (without its parentheses). */
  sql: string;
  /** The Sankhya tables it reads. */
  tables: string[];
  /** Offsets of the text in the statement. */
  start: number;
  end: number;
}

export interface HybridSplit {
  parts: HybridPart[];
  /**
   * The statement has more subqueries than `maxGroups`, or more parts than `maxParts`: the split
   * stopped early (each candidate costs a parse) and `parts` is incomplete. Callers refuse it.
   */
  overflow: boolean;
  /** Rewrites the statement with each part replaced by `SELECT * FROM <name>` (same order). */
  rewrite(names: readonly string[]): string;
}

/**
 * The outermost subqueries that read only tables `isScratch` rejects. A subquery that reads a
 * scratch table is not a part, but the subqueries inside it may be. Identical parts (same text)
 * are listed once, so each runs once.
 */
export function splitHybrid(
  sql: string,
  isScratch: (table: string) => boolean,
  limits: { maxParts?: number; maxGroups?: number } = {},
): HybridSplit {
  const maxParts = limits.maxParts ?? Infinity;
  const maxGroups = limits.maxGroups ?? Infinity;
  const tokens = tokenize(sql, { ansi: true }).filter(isSignificant);
  const groups: Array<{ start: number; end: number }> = [];
  const open: number[] = [];
  tokens.forEach((tok, i) => {
    if (tok.type !== 'symbol') return;
    if (tok.text === '(') open.push(i);
    else if (tok.text === ')') {
      const from = open.pop();
      if (from === undefined) return;
      const first = tokens[from + 1];
      if (first?.type === 'word' && /^(select|with)$/i.test(first.text)) {
        groups.push({ start: tokens[from]!.end, end: tok.start });
      }
    }
  });
  if (groups.length > maxGroups) return { parts: [], overflow: true, rewrite: refuse };
  groups.sort((a, b) => a.start - b.start || b.end - a.end);

  const chosen: HybridPart[] = [];
  const texts = new Set<string>();
  for (const g of groups) {
    if (chosen.some((c) => g.start >= c.start && g.end <= c.end)) continue;
    const text = sql.slice(g.start, g.end);
    const classified = classifyStatement(text);
    if (classified.kind !== 'SELECT' || classified.tables.length === 0) continue;
    if (classified.tables.some(isScratch)) continue;
    chosen.push({ sql: text.trim(), tables: classified.tables, start: g.start, end: g.end });
    texts.add(text.trim());
    if (texts.size > maxParts) return { parts: [], overflow: true, rewrite: refuse };
  }

  const unique: HybridPart[] = [];
  const indexOf = chosen.map((c) => {
    const at = unique.findIndex((u) => u.sql === c.sql);
    if (at !== -1) return at;
    unique.push(c);
    return unique.length - 1;
  });

  return {
    parts: unique,
    overflow: false,
    rewrite(names) {
      if (names.length !== unique.length) throw new Error('One name per part is needed.');
      let out = '';
      let at = 0;
      chosen.forEach((c, i) => {
        out += `${sql.slice(at, c.start)}SELECT * FROM ${names[indexOf[i]!]}`;
        at = c.end;
      });
      return out + sql.slice(at);
    },
  };
}

export interface CreateAs {
  /** `CREATE … TABLE <name> AS `, exactly as written (with the space after AS). */
  head: string;
  /** The query, as written, without wrapping parentheses. */
  query: string;
}

const CREATE_MODIFIERS = /^(temp|temporary|global|local|unlogged)$/i;

/**
 * Splits `CREATE [TEMP] TABLE [IF NOT EXISTS] <name> AS <query>` into its head and its query,
 * lexically, so the query keeps the exact text the user wrote. Null for anything else (a column
 * list, a second statement, a query that is not a SELECT / WITH).
 */
export function splitCreateAs(sql: string): CreateAs | null {
  const tokens = tokenize(sql, { ansi: true }).filter(isSignificant);
  const word = (i: number, re: RegExp) => tokens[i]?.type === 'word' && re.test(tokens[i]!.text);
  let i = 0;
  if (!word(i++, /^create$/i)) return null;
  while (word(i, CREATE_MODIFIERS)) i++;
  if (!word(i++, /^table$/i)) return null;
  if (word(i, /^if$/i)) {
    if (!word(i + 1, /^not$/i) || !word(i + 2, /^exists$/i)) return null;
    i += 3;
  }
  if (tokens[i]?.type !== 'word') return null;
  i++;
  if (tokens[i]?.text === '.' && tokens[i + 1]?.type === 'word') i += 2;
  if (!word(i++, /^as$/i)) return null;
  const rest = tokens.slice(i);
  // One statement: a trailing semicolon is fine, a second statement is not.
  const semi = rest.findIndex((t) => t.text === ';');
  if (semi !== -1 && semi !== rest.length - 1) return null;
  const body = semi === -1 ? rest : rest.slice(0, -1);
  if (body.length === 0) return null;
  let first = 0;
  let last = body.length - 1;
  // `AS (query)`: drop the parentheses when they wrap the whole query.
  if (body[0]!.text === '(' && body[last]!.text === ')' && closes(body, 0) === last) {
    first = 1;
    last -= 1;
  }
  if (first > last || body[first]!.type !== 'word' || !/^(select|with)$/i.test(body[first]!.text)) {
    return null;
  }
  return {
    head: sql.slice(0, body[0]!.start),
    query: sql.slice(body[first]!.start, body[last]!.end),
  };
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function closes(tokens: ReadonlyArray<{ text: string }>, open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i]!.text === '(') depth++;
    else if (tokens[i]!.text === ')' && --depth === 0) return i;
  }
  return -1;
}

function refuse(): string {
  throw new Error('An overflowing split cannot be rewritten.');
}
