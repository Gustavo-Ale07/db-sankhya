import { useMemo, useState } from 'react';
import type { CatalogTable } from '../api/types';
import { groupByPrefix } from './schemaGroups';

interface Props {
  tables: CatalogTable[] | undefined;
  loading: boolean;
  onSelectQuery: (sql: string, table: string) => void;
  onInsertText: (text: string) => void;
}

/** Starter query for a table. No row limit clause: the server caps the rows it returns. */
export function selectTemplate(t: CatalogTable): string {
  return `SELECT *\nFROM ${t.name}`;
}

export function SchemaTree({ tables, loading, onSelectQuery, onInsertText }: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  const filtering = filter.trim() !== '';
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return groupByPrefix(
      (tables ?? []).filter(
        (t) =>
          !f ||
          t.name.toLowerCase().includes(f) ||
          (t.description ?? '').toLowerCase().includes(f) ||
          t.columns.some((c) => c.name.toLowerCase().includes(f)),
      ),
    );
  }, [tables, filter]);

  function renderTable(t: CatalogTable) {
    const isOpen = open[t.name] ?? false;
    const refs = new Map(t.foreignKeys.map((fk) => [fk.column, fk]));
    return (
      <div key={t.name} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
        <div className="group flex items-center gap-1 pr-1 pl-5 hover:bg-hover">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 py-0.5 text-left"
            onClick={() => setOpen((o) => ({ ...o, [t.name]: !isOpen }))}
            onDoubleClick={() => onSelectQuery(selectTemplate(t), t.name)}
            title={t.description ?? t.name}
            data-testid={`schema-table-${t.name}`}
          >
            <span aria-hidden className="text-muted">
              {isOpen ? '▾' : '▸'}
            </span>
            <span aria-hidden>▦</span>
            <span className="truncate font-mono">{t.name}</span>
          </button>
          <button
            type="button"
            className="rounded px-1 text-[11px] text-accent opacity-70 group-hover:opacity-100 hover:underline"
            onClick={() => onSelectQuery(selectTemplate(t), t.name)}
            title={`SELECT * FROM ${t.name}`}
            aria-label={`Consultar ${t.name} (SELECT *)`}
          >
            SELECT
          </button>
        </div>
        {isOpen && (
          <div className="mb-1 ml-9 border-l border-line pl-2">
            {t.description && <p className="py-0.5 text-[11px] text-muted">{t.description}</p>}
            <ul className="py-0.5">
              {t.columns.map((c) => {
                const ref = refs.get(c.name);
                return (
                  <li key={c.name}>
                    <button
                      type="button"
                      className="flex w-full items-center gap-1 rounded px-1 text-left hover:bg-hover"
                      title={`${c.description ?? ''}${ref ? ` → ${ref.refTable}.${ref.refColumn}` : ''}\nClique para inserir no editor`}
                      onClick={() => onInsertText(c.name)}
                    >
                      <span className="w-3 text-[10px] text-warn" aria-hidden>
                        {c.pk ? '🔑' : ref ? '↗' : ''}
                      </span>
                      <span className="truncate font-mono">{c.name}</span>
                      <span className="ml-auto pl-2 font-mono text-[10px] text-muted">
                        {c.type}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line p-2">
        <label className="sr-only" htmlFor="schema-filter">
          Filtrar tabelas
        </label>
        <input
          id="schema-filter"
          className="input w-full text-xs"
          placeholder="Filtrar tabelas e colunas…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1 text-xs" role="tree" aria-label="Tabelas">
        {loading && <div className="p-2 text-muted">Carregando schema…</div>}
        {groups.map((g) => {
          // A filter opens every group so matches are never hidden behind a collapsed prefix.
          const groupOpen = filtering || (openGroups[g.prefix] ?? false);
          return (
            <div key={g.prefix} role="group" aria-label={`Prefixo ${g.prefix}`}>
              <button
                type="button"
                className="flex w-full items-center gap-1 px-2 py-0.5 text-left font-semibold hover:bg-hover"
                aria-expanded={groupOpen}
                onClick={() => setOpenGroups((o) => ({ ...o, [g.prefix]: !groupOpen }))}
                data-testid={`schema-group-${g.prefix}`}
              >
                <span aria-hidden className="text-muted">
                  {groupOpen ? '▾' : '▸'}
                </span>
                <span className="font-mono">{g.prefix}</span>
                <span className="ml-auto text-[10px] font-normal text-muted">
                  {g.tables.length}
                </span>
              </button>
              {groupOpen && g.tables.map(renderTable)}
            </div>
          );
        })}
        {!loading && groups.length === 0 && (
          <div className="p-2 text-muted">Nenhuma tabela encontrada.</div>
        )}
      </div>
    </div>
  );
}
