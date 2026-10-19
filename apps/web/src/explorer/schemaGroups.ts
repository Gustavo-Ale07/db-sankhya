import type { CatalogTable } from '../api/types';

export interface TableGroup {
  prefix: string;
  tables: CatalogTable[];
}

/**
 * Prefix a table is grouped under: the part before the first underscore for custom tables
 * (`AD_CLIENTE` -> `AD_`), else the first three letters of the dictionary name
 * (`TGFPAR` -> `TGF`). Short names form their own group.
 */
export function tablePrefix(name: string): string {
  const upper = name.toUpperCase();
  const underscore = upper.indexOf('_');
  if (underscore > 0) return upper.slice(0, underscore + 1);
  return upper.length > 3 ? upper.slice(0, 3) : upper;
}

/** Groups tables by prefix; groups and the tables inside them are sorted by name. */
export function groupByPrefix(tables: readonly CatalogTable[]): TableGroup[] {
  const groups = new Map<string, CatalogTable[]>();
  for (const t of tables) {
    const prefix = tablePrefix(t.name);
    const list = groups.get(prefix);
    if (list) list.push(t);
    else groups.set(prefix, [t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, list]) => ({
      prefix,
      tables: list.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
