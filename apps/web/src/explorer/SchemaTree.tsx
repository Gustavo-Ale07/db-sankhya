import { useEffect, useMemo, useState } from 'react';
import type { CatalogTable } from '../api/types';
import { Icon } from '../components/Icon';
import { groupByPrefix } from './schemaGroups';

interface Props {
  tables: CatalogTable[] | undefined;
  loading: boolean;
  onSelectQuery: (sql: string, table: string) => void;
  onInsertText: (text: string) => void;
  /**
   * Set when the catalog may list only some columns of a table (the dictionary was cut): the
   * columns of an expanded table are then read on their own, and the partial list is never shown.
   * A new function (another connection) drops what the previous one answered.
   */
  loadTable?: (name: string) => Promise<CatalogTable>;
  /** What the dictionary read lost (`TDDCAM:truncated`, ...); a non-empty list is shown. */
  degraded?: string[];
  /** Reads the catalog again (POST /api/schema/refresh). */
  onRefresh?: () => void;
  refreshing?: boolean;
}

type Detail = { status: 'loading' } | { status: 'ok'; table: CatalogTable } | { status: 'error' };
const NO_DETAILS: Record<string, Detail> = {};

/** Starter query for a table. No row limit clause: the server caps the rows it returns. */
export function selectTemplate(t: CatalogTable): string {
  return `SELECT *\nFROM ${t.name}`;
}

export function SchemaTree({
  tables,
  loading,
  onSelectQuery,
  onInsertText,
  loadTable,
  degraded,
  onRefresh,
  refreshing = false,
}: Props) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [details, setDetails] = useState<{
    load?: Props['loadTable'];
    byName: Record<string, Detail>;
  }>({ byName: {} });
  const byName = details.load === loadTable ? details.byName : NO_DETAILS;

  useEffect(() => {
    if (!loadTable) return;
    const wanted = Object.keys(open).filter((name) => open[name] && !byName[name]);
    if (wanted.length === 0) return;
    // Only an answer of the current loader is kept: a late one from another connection is dropped.
    const settle = (name: string, detail: Detail) =>
      setDetails((cur) =>
        cur.load === loadTable
          ? { load: cur.load, byName: { ...cur.byName, [name]: detail } }
          : cur,
      );
    setDetails((cur) => {
      const next = { ...(cur.load === loadTable ? cur.byName : {}) };
      for (const name of wanted) next[name] = { status: 'loading' };
      return { load: loadTable, byName: next };
    });
    for (const name of wanted) {
      loadTable(name).then(
        (table) => settle(name, { status: 'ok', table }),
        () => settle(name, { status: 'error' }),
      );
    }
  }, [loadTable, open, byName]);

  const filtering = filter.trim() !== '';
  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    // With a cut column list, only the columns of a table read on its own are matched: matching
    // the partial list would hide the tables whose list lost the column.
    const columnsOf = (t: CatalogTable) => {
      if (!loadTable) return t.columns;
      const detail = byName[t.name];
      return detail?.status === 'ok' ? detail.table.columns : [];
    };
    return groupByPrefix(
      (tables ?? []).filter(
        (t) =>
          !f ||
          t.name.toLowerCase().includes(f) ||
          (t.description ?? '').toLowerCase().includes(f) ||
          columnsOf(t).some((c) => c.name.toLowerCase().includes(f)),
      ),
    );
  }, [tables, filter, loadTable, byName]);

  function renderTable(t: CatalogTable) {
    const isOpen = open[t.name] ?? false;
    const detail = loadTable ? byName[t.name] : undefined;
    const shown = loadTable ? (detail?.status === 'ok' ? detail.table : undefined) : t;
    const refs = new Map((shown?.foreignKeys ?? []).map((fk) => [fk.column, fk]));
    return (
      <div key={t.name} role="treeitem" aria-expanded={isOpen} aria-selected={false}>
        <div className="group flex items-center gap-1 pr-1 pl-1 hover:bg-hover">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1 py-px text-left"
            onClick={() => setOpen((o) => ({ ...o, [t.name]: !isOpen }))}
            onDoubleClick={() => onSelectQuery(selectTemplate(t), t.name)}
            title={t.description ?? t.name}
            data-testid={`schema-table-${t.name}`}
          >
            <Icon
              name={isOpen ? 'chevron-down' : 'chevron-right'}
              size={12}
              className="text-muted"
            />
            <Icon name="table" size={13} className="text-accent" />
            <span className="truncate font-mono">{t.name}</span>
          </button>
          <button
            type="button"
            className="rounded px-1 text-[10px] text-accent opacity-60 group-hover:opacity-100 hover:underline"
            onClick={() => onSelectQuery(selectTemplate(t), t.name)}
            title={`SELECT * FROM ${t.name}`}
            aria-label={`Consultar ${t.name} (SELECT *)`}
          >
            SELECT
          </button>
        </div>
        {isOpen && (
          <div className="ml-[0.6rem] border-l border-line pl-1.5">
            {t.description && (
              <p className="truncate py-px text-[11px] text-muted" title={t.description}>
                {t.description}
              </p>
            )}
            {!shown && detail?.status === 'error' && (
              <p className="py-px text-[11px] text-danger" role="alert">
                Não foi possível ler as colunas desta tabela.
              </p>
            )}
            {!shown && detail?.status !== 'error' && (
              <p className="py-px text-[11px] text-muted">Carregando colunas…</p>
            )}
            {shown && (
              <ul data-testid={`schema-columns-${t.name}`}>
                {shown.columns.map((c) => {
                  const ref = refs.get(c.name);
                  return (
                    <li key={c.name}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-1 rounded px-1 py-px text-left hover:bg-hover"
                        title={`${c.description ?? ''}${ref ? ` → ${ref.refTable}.${ref.refColumn}` : ''}
Clique para inserir no editor`}
                        onClick={() => onInsertText(c.name)}
                      >
                        <Icon
                          name={c.pk ? 'key' : ref ? 'link' : 'column'}
                          size={12}
                          className={c.pk || ref ? 'text-warn' : 'text-muted'}
                        />
                        <span className="sr-only">
                          {c.pk ? 'Chave primária: ' : ref ? 'Chave estrangeira: ' : ''}
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
            )}
          </div>
        )}
      </div>
    );
  }

  const visible = groups.reduce((n, g) => n + g.tables.length, 0);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-line bg-panel2 px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
        <Icon name="table" size={13} />
        <span>Tabelas</span>
        {tables && (
          <span
            className="ml-auto rounded-full border border-line px-1.5 font-normal tracking-normal normal-case"
            data-testid="schema-count"
            title={filtering ? `${visible} de ${tables.length} tabelas` : `${visible} tabelas`}
          >
            {filtering ? `${visible}/${tables.length}` : visible}
          </span>
        )}
      </div>
      {degraded && degraded.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-line px-2 py-1 text-[11px]">
          <span
            className="badge border-warn/60 text-warn"
            data-testid="schema-degraded"
            title={`O dicionário não foi lido por inteiro (${degraded.join(', ')}). Tabelas e colunas que faltam são lidas uma a uma quando usadas.`}
          >
            Catálogo incompleto
          </span>
          {onRefresh && (
            <button
              type="button"
              className="ml-auto flex items-center gap-1 rounded px-1 text-accent hover:underline disabled:opacity-50"
              onClick={onRefresh}
              disabled={refreshing}
              aria-label="Recarregar catálogo"
              title="Ler o dicionário de dados de novo"
            >
              <Icon name="refresh" size={12} />
              {refreshing ? 'Lendo…' : 'Recarregar'}
            </button>
          )}
        </div>
      )}
      <div className="relative border-b border-line p-1.5">
        <label className="sr-only" htmlFor="schema-filter">
          Filtrar tabelas
        </label>
        <Icon
          name="search"
          size={12}
          className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
        />
        <input
          id="schema-filter"
          className="input input-search w-full"
          placeholder={
            loadTable
              ? 'Filtrar tabelas (colunas só das tabelas abertas)…'
              : 'Filtrar tabelas e colunas…'
          }
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-0.5 text-xs" role="tree" aria-label="Tabelas">
        {loading && <div className="p-2 text-muted">Carregando schema…</div>}
        {groups.map((g) => {
          // A filter opens every group so matches are never hidden behind a collapsed prefix.
          const groupOpen = filtering || (openGroups[g.prefix] ?? false);
          return (
            <div key={g.prefix} role="group" aria-label={`Prefixo ${g.prefix}`}>
              <button
                type="button"
                className="flex w-full items-center gap-1 px-1 py-px text-left font-semibold hover:bg-hover"
                aria-expanded={groupOpen}
                onClick={() => setOpenGroups((o) => ({ ...o, [g.prefix]: !groupOpen }))}
                data-testid={`schema-group-${g.prefix}`}
              >
                <Icon
                  name={groupOpen ? 'chevron-down' : 'chevron-right'}
                  size={12}
                  className="text-muted"
                />
                <Icon name="folder" size={13} className="text-warn" />
                <span className="font-mono">{g.prefix}</span>
                <span className="ml-auto text-[10px] font-normal text-muted">
                  {g.tables.length}
                </span>
              </button>
              {groupOpen && (
                <div className="ml-[0.6rem] border-l border-line">{g.tables.map(renderTable)}</div>
              )}
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
