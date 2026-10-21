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
  /** Rewrites the statement with each part replaced by `SELECT * FROM <name>` (same order). */
  rewrite(names: readonly string[]): string;
}

/**
 * The outermost subqueries that read only tables `isScratch` rejects. A subquery that reads a
 * scratch table is not a part, but the subqueries inside it may be. Identical parts (same text)
 * are listed once, so each runs once.
 */
export function splitHybrid(sql: string, isScratch: (table: string) => boolean): HybridSplit {
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
  groups.sort((a, b) => a.start - b.start || b.end - a.end);

  const chosen: HybridPart[] = [];
  for (const g of groups) {
    if (chosen.some((c) => g.start >= c.start && g.end <= c.end)) continue;
    const text = sql.slice(g.start, g.end);
    const classified = classifyStatement(text);
    if (classified.kind !== 'SELECT' || classified.tables.length === 0) continue;
    if (classified.tables.some(isScratch)) continue;
    chosen.push({ sql: text.trim(), tables: classified.tables, start: g.start, end: g.end });
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
