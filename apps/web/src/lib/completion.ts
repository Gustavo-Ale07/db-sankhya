// Context-aware SQL suggestions (pure; Monaco only renders them).
import type { CatalogTable } from '../api/types';

/** The full read-only SELECT vocabulary (CTEs, CASE, set operators, every join, windows). */
export const SQL_KEYWORDS = [
  'WITH',
  'SELECT',
  'DISTINCT',
  'ALL',
  'TOP',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'EXISTS',
  'ANY',
  'SOME',
  'BETWEEN',
  'LIKE',
  'ESCAPE',
  'IS',
  'NULL',
  'AS',
  'CASE',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'ORDER BY',
  'GROUP BY',
  'HAVING',
  'ASC',
  'DESC',
  'NULLS FIRST',
  'NULLS LAST',
  'UNION',
  'UNION ALL',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
  'JOIN',
  'INNER JOIN',
  'LEFT JOIN',
  'LEFT OUTER JOIN',
  'RIGHT JOIN',
  'RIGHT OUTER JOIN',
  'FULL JOIN',
  'FULL OUTER JOIN',
  'CROSS JOIN',
  'ON',
  'USING',
  'OVER',
  'PARTITION BY',
  'OFFSET',
  'FETCH FIRST',
  'ROWS ONLY',
  'TRUE',
  'FALSE',
];

export const SQL_FUNCTIONS = [
  'COUNT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'COALESCE',
  'NULLIF',
  'CAST',
  'UPPER',
  'LOWER',
  'TRIM',
  'SUBSTR',
  'LENGTH',
  'ROUND',
  'ABS',
];

const RESERVED = new Set(
  [
    'where',
    'inner',
    'left',
    'join',
    'on',
    'order',
    'group',
    'limit',
    'offset',
    'set',
    'values',
    'as',
    'union',
    'intersect',
    'except',
    'minus',
    'having',
    'right',
    'full',
    'cross',
    'outer',
    'using',
    'fetch',
    'when',
    'then',
    'else',
    'end',
    'over',
  ].map((s) => s.toLowerCase()),
);

export type SuggestionKind = 'table' | 'column' | 'keyword' | 'function' | 'alias';

export interface Suggestion {
  label: string;
  kind: SuggestionKind;
  detail: string;
  insertText: string;
  documentation?: string;
}

/** alias (or table name) → table name, from FROM / JOIN clauses. */
export function findAliases(sql: string, tables: CatalogTable[]): Map<string, string> {
  const known = new Set(tables.map((t) => t.name.toLowerCase()));
  const out = new Map<string, string>();
  const re = /\b(?:from|join)\s+([a-z_][\w]*)(?:\s+(?:as\s+)?([a-z_][\w]*))?/gi;
  for (const m of sql.matchAll(re)) {
    const table = (m[1] ?? '').toLowerCase();
    if (!known.has(table)) continue;
    out.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !RESERVED.has(alias) && !known.has(alias)) out.set(alias, table);
  }
  return out;
}

/**
 * The catalog with every table the SQL names replaced by its complete version from `load` (for a
 * dictionary cut at the gateway row cap, which lists only some columns of a table). A table that
 * cannot be loaded keeps what the catalog had: this only feeds suggestions.
 */
export async function withTablesOf(
  sql: string,
  tables: CatalogTable[],
  load: (name: string) => Promise<CatalogTable>,
): Promise<CatalogTable[]> {
  const named = new Set(findAliases(sql, tables).values());
  if (named.size === 0) return tables;
  const loaded = new Map<string, CatalogTable>();
  await Promise.all(
    tables
      .filter((t) => named.has(t.name.toLowerCase()))
      .map((t) =>
        load(t.name).then(
          (full) => void loaded.set(t.name, full),
          () => undefined,
        ),
      ),
  );
  return tables.map((t) => loaded.get(t.name) ?? t);
}

function tableSuggestion(t: CatalogTable): Suggestion {
  return {
    label: t.name,
    kind: 'table',
    detail: t.description ? `tabela · ${t.description}` : 'tabela',
    insertText: t.name,
    ...(t.description ? { documentation: t.description } : {}),
  };
}

function columnSuggestions(t: CatalogTable, qualifier?: string): Suggestion[] {
  return t.columns.map((c) => ({
    label: c.name,
    kind: 'column' as const,
    detail: `${c.type}${c.pk ? ' · PK' : ''} · ${qualifier ?? t.name}`,
    insertText: c.name,
    ...(c.description ? { documentation: c.description } : {}),
  }));
}

/**
 * Suggestions for the cursor position.
 * @param textBefore SQL from the start of the statement up to the cursor.
 * @param fullText the whole editor text (aliases may be declared after the cursor).
 */
export function suggest(
  textBefore: string,
  fullText: string,
  tables: CatalogTable[],
): Suggestion[] {
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const aliases = findAliases(fullText, tables);

  // "alias." or "table." → that table's columns.
  const dotted = /([a-z_][\w]*)\.([\w]*)$/i.exec(textBefore);
  if (dotted) {
    const target = aliases.get(dotted[1]!.toLowerCase()) ?? dotted[1]!.toLowerCase();
    const t = byName.get(target);
    return t ? columnSuggestions(t, dotted[1]) : [];
  }

  // Right after FROM / JOIN → tables.
  if (/\b(?:from|join)\s+[\w]*$/i.test(textBefore)) {
    return tables.map(tableSuggestion);
  }

  const inScope = [...new Set(aliases.values())]
    .map((n) => byName.get(n))
    .filter((t): t is CatalogTable => Boolean(t));
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const t of inScope) {
    for (const s of columnSuggestions(t)) {
      if (seen.has(s.label)) continue;
      seen.add(s.label);
      out.push(s);
    }
  }
  for (const [alias, table] of aliases) {
    if (alias !== table)
      out.push({ label: alias, kind: 'alias', detail: `alias de ${table}`, insertText: alias });
  }
  for (const f of SQL_FUNCTIONS)
    out.push({ label: f, kind: 'function', detail: 'agregação', insertText: `${f}(` });
  for (const k of SQL_KEYWORDS) out.push({ label: k, kind: 'keyword', detail: '', insertText: k });
  if (inScope.length === 0) out.push(...tables.map(tableSuggestion));
  return out;
}

/** The statement under the cursor (statements are separated by ';' outside strings). */
export function statementAt(text: string, offset: number): { sql: string; start: number } {
  let start = 0;
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === inStr) {
        if (text[i + 1] === inStr) i++;
        else inStr = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') inStr = ch;
    else if (ch === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl;
    } else if (ch === ';') {
      if (offset <= i) return { sql: text.slice(start, i).trim(), start };
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail || start === 0) return { sql: tail, start };
  // Cursor after the last ';' with nothing else: use the previous statement.
  const prev = text.slice(0, start - 1);
  const prevStart = prev.lastIndexOf(';') + 1;
  return { sql: prev.slice(prevStart).trim(), start: prevStart };
}
