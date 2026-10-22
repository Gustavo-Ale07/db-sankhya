import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, newExecutionId } from '../api/client';
import { previewMutation } from '../api/mutations';
import type { PreparedPlan } from '../api/mutations';
import type {
  QueryResult,
  SavedQuery,
  ScratchSchema,
  SchemaResponse,
  SchemaTableResponse,
} from '../api/types';
import type { Theme } from '../app/theme';
import { useSession } from '../app/session';
import { setCompletionSchema } from '../editor/monaco';
import { ErrorBox } from '../components/ErrorBox';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';
import { MutationDialog } from './MutationDialog';
import { dropPlan, getPendingPlan, rememberPlan, updatePlan, usePendingPlan } from './pendingPlans';
import type { PendingPlan } from './pendingPlans';
import { ResultsPanel } from './ResultsPanel';
import type { ResultTab } from './ResultsPanel';
import { SavedQueryPicker } from './SavedQueryPicker';
import { SchemaTree, scratchAsCatalog } from './SchemaTree';
import { SqlEditor } from './SqlEditor';
import type { EditorApi } from './SqlEditor';
import { isPreviewPointer } from './runState';
import type { RunState } from './runState';
import { loadTabs, newTab, saveTabs } from './tabs';
import type { EditorTab } from './tabs';

export interface OpenRequest {
  sql: string;
  title?: string;
  savedId?: string;
  run?: boolean;
  nonce: number;
}

/**
 * A plan the server already prepared (the assisted rollback), to open in the dialog as is: no
 * second preview, so execute consumes exactly that plan. It opens only while `connectionId` is
 * the selected connection.
 */
export interface OpenPlanRequest {
  plan: PreparedPlan;
  sql: string;
  title?: string;
  connectionId: string;
  nonce: number;
}

interface Props {
  theme: Theme;
  openRequest: OpenRequest | null;
  planRequest?: OpenPlanRequest | null;
  active: boolean;
  /** Selected connection. Undefined (loading, error, empty list) blocks running queries. */
  connectionId?: string | undefined;
  /** Name of the selected connection, shown with the results read from it. */
  connectionName?: string | undefined;
  /** False while the connection list is still loading, so no call goes out with a stale default. */
  connectionReady?: boolean;
}

const SCHEMA_WIDTH_KEY = 'dbx.schemaWidth';
export const SCHEMA_WIDTH_MIN = 180;
export const SCHEMA_WIDTH_MAX = 480;
const SCHEMA_WIDTH_DEFAULT = 256;
const SCHEMA_WIDTH_STEP = 16;

/** Widest the schema panel may be: 480px, or half the window on narrow screens (never below the minimum). */
export function schemaWidthMax(): number {
  const half = typeof window !== 'undefined' ? window.innerWidth * 0.5 : SCHEMA_WIDTH_MAX;
  return Math.max(SCHEMA_WIDTH_MIN, Math.floor(Math.min(SCHEMA_WIDTH_MAX, half)));
}

const clampSchemaWidth = (n: number) =>
  Math.round(Math.max(SCHEMA_WIDTH_MIN, Math.min(schemaWidthMax(), n)));

/** Width of the schema panel: a per-browser layout preference, never anything sensitive. */
function loadSchemaWidth(): number {
  try {
    const n = Number(localStorage.getItem(SCHEMA_WIDTH_KEY));
    if (Number.isFinite(n) && n > 0) return clampSchemaWidth(n);
  } catch {
    // Storage unavailable: the default width.
  }
  return SCHEMA_WIDTH_DEFAULT;
}

function saveSchemaWidth(n: number): void {
  try {
    localStorage.setItem(SCHEMA_WIDTH_KEY, String(n));
  } catch {
    // Storage unavailable: the width just won't survive a reload.
  }
}

export function ExplorerPage({
  theme,
  openRequest,
  planRequest = null,
  active,
  connectionId,
  connectionName,
  connectionReady = true,
}: Props) {
  const { user } = useSession();
  const qc = useQueryClient();
  const [tabs, setTabs] = useState<EditorTab[]>(() => loadTabs(user.id).tabs);
  const [activeId, setActiveId] = useState<string>(() => loadTabs(user.id).activeId);
  const [runs, setRuns] = useState<Record<string, RunState>>({});
  const [resultTab, setResultTab] = useState<Record<string, ResultTab>>({});
  const [showSchema, setShowSchema] = useState(true);
  const [schemaWidth, setSchemaWidth] = useState(loadSchemaWidth);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [saveDialog, setSaveDialog] = useState<{ name: string; description: string } | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(45);
  // The open mutation plan. Its token lives only in memory (here and in the pending-plan store,
  // which lets a closed dialog be reopened): never in tabs, storage or logs.
  const [mutation, setMutation] = useState<PendingPlan | null>(null);
  const editorApi = useRef<EditorApi | null>(null);
  const aborts = useRef<Record<string, AbortController>>({});
  // Controllers aborted by a connection switch, not by the user.
  const dropped = useRef(new WeakSet<AbortController>());
  // Tabs whose mutation preview is being prepared: a second run (Ctrl+Enter, F5) is ignored
  // until it answers, so two plans never race for the same dialog.
  const previewing = useRef(new Set<string>());
  const splitRef = useRef<HTMLDivElement>(null);

  const schema = useQuery({
    queryKey: ['schema', connectionId ?? null],
    // Data dictionary of the selected connection; feeds the tree and the completion.
    queryFn: () => api.get<SchemaResponse>('/api/schema', { query: { connectionId } }),
    enabled: connectionReady && Boolean(connectionId),
    staleTime: 5 * 60_000,
  });
  // A dictionary cut at the gateway row cap may list only some columns of a table: the tree then
  // reads the columns of an expanded table on their own.
  const columnsCut = schema.data?.catalog.degraded?.some((d) => d.startsWith('TDDCAM:')) ?? false;
  const loadTable = useMemo(
    () =>
      columnsCut && connectionId
        ? (name: string) =>
            api
              .get<SchemaTableResponse>(`/api/schema/tables/${encodeURIComponent(name)}`, {
                query: { connectionId },
              })
              .then((r) => r.table)
        : undefined,
    [columnsCut, connectionId],
  );
  // The caller's tmp_ tables, with columns and rows (policy-filtered by the server): the
  // "Temporárias" group of the tree and the autocomplete. Read again after every command.
  const scratch = useQuery({
    queryKey: ['scratch-tables', 'columns'],
    queryFn: () => api.get<ScratchSchema>('/api/scratch/tables', { query: { columns: '1' } }),
    staleTime: 30_000,
  });
  const scratchSchema = Array.isArray(scratch.data?.tables) ? scratch.data : undefined;
  const refreshScratch = useCallback(
    () => void qc.invalidateQueries({ queryKey: ['scratch-tables'] }),
    [qc],
  );
  const refresh = useMutation({
    mutationFn: (id: string) =>
      api.post<SchemaResponse>('/api/schema/refresh', {}, { query: { connectionId: id } }),
    onSuccess: (res, id) => qc.setQueryData(['schema', id], res),
    onError: () => flash('Não foi possível recarregar o catálogo.'),
  });
  // Another connection: what runs is aborted and every result, error or run of the previous one
  // is cleared, so an answer of one connection is never shown under another. Plans stay: they
  // carry their own connection and refuse to reopen elsewhere.
  const shownConnection = useRef(connectionId);
  useEffect(() => {
    if (shownConnection.current === connectionId) return;
    shownConnection.current = connectionId;
    for (const controller of Object.values(aborts.current)) {
      dropped.current.add(controller);
      controller.abort();
    }
    aborts.current = {};
    setRuns((all) =>
      Object.fromEntries(Object.entries(all).filter(([, r]) => r.status === 'mutation')),
    );
  }, [connectionId]);
  useEffect(() => {
    // Cleared while another connection's dictionary loads: no suggestions from the wrong one.
    const own = (scratchSchema?.tables ?? []).map(scratchAsCatalog);
    const byName = new Map(own.map((t) => [t.name, t]));
    // A tmp_ table is complete as listed: never read from the Sankhya dictionary.
    const load =
      loadTable &&
      ((name: string) => {
        const t = byName.get(name);
        return t ? Promise.resolve(t) : loadTable(name);
      });
    setCompletionSchema([...own, ...(schema.data?.catalog.tables ?? [])], load);
  }, [schema.data, loadTable, scratchSchema]);

  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0]!;
  const run: RunState = runs[tab.id] ?? { status: 'idle' };

  useEffect(() => saveTabs(user.id, tabs, tab.id), [user.id, tabs, tab.id]);

  const flash = useCallback((msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice((n) => (n === msg ? null : n)), 2500);
  }, []);

  const setRun = (id: string, r: RunState) => setRuns((all) => ({ ...all, [id]: r }));

  /** Opens the dialog on a plan and keeps it in memory, with one idempotency key, until it settles. */
  const openPlan = useCallback(
    (tabId: string, sql: string, preview: PreparedPlan, planConnection: string) => {
      const entry: PendingPlan = {
        planId: preview.planId,
        preview,
        idempotencyKey: crypto.randomUUID(),
        connectionId: planConnection,
        sql,
        tabId,
        approvalRequested: false,
      };
      rememberPlan(entry);
      setRun(tabId, { status: 'mutation', sql, planId: preview.planId });
      setMutation(entry);
    },
    [],
  );
  const updateTab = (id: string, patch: Partial<EditorTab>) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  const execute = useCallback(
    async (sqlText: string, tabId: string) => {
      const sql = sqlText.trim().replace(/;\s*$/, '');
      if (!sql) return;
      // Never run against an environment the banner is not showing.
      if (!connectionId) return;
      if (previewing.current.has(tabId)) return;
      aborts.current[tabId]?.abort();
      const controller = new AbortController();
      aborts.current[tabId] = controller;
      const executionId = newExecutionId();
      setRun(tabId, { status: 'running', sql, executionId, startedAt: Date.now() });
      // Superseded by another run, or dropped by a connection switch: the answer is not shown.
      const stale = () => aborts.current[tabId] !== controller || controller.signal.aborted;
      try {
        const res = await api.post<QueryResult>(
          '/api/query',
          { sql, executionId, ...(connectionId ? { connectionId } : {}) },
          { signal: controller.signal },
        );
        if (stale()) return;
        if (res.connectionId !== connectionId) {
          setRun(tabId, {
            status: 'error',
            sql,
            error: new ApiError(499, {
              code: 'QUERY_CANCELLED',
              message: 'A resposta veio de outra conexão e foi descartada.',
            }),
          });
          return;
        }
        setRun(tabId, { status: 'result', sql, result: res });
        setResultTab((m) => ({ ...m, [tabId]: 'results' }));
      } catch (err) {
        if (dropped.current.has(controller)) {
          // Aborted by a connection switch: the run was already cleared.
        } else if (err instanceof DOMException && err.name === 'AbortError') {
          setRun(tabId, {
            status: 'error',
            sql,
            error: new ApiError(499, { code: 'QUERY_CANCELLED', message: 'Cancelled by the user' }),
          });
        } else if (isPreviewPointer(err) && aborts.current[tabId] === controller) {
          // The client never classifies SQL: the server said this is a previewable mutation.
          // The preview plans it and writes nothing; only an explicit click in the dialog
          // executes, so Ctrl+Enter can never write.
          setRun(tabId, { status: 'previewing', sql });
          setResultTab((m) => ({ ...m, [tabId]: 'results' }));
          previewing.current.add(tabId);
          try {
            const preview = await previewMutation(sql, connectionId, controller.signal);
            // A late answer (tab closed, run superseded) never opens a dialog.
            if (aborts.current[tabId] === controller && !controller.signal.aborted) {
              openPlan(tabId, sql, preview, connectionId);
            }
          } catch (previewErr) {
            if (aborts.current[tabId] === controller) {
              setRun(tabId, { status: 'error', sql, error: previewErr });
            }
          } finally {
            previewing.current.delete(tabId);
          }
        } else {
          setRun(tabId, { status: 'error', sql, error: err });
          setResultTab((m) => ({ ...m, [tabId]: 'results' }));
        }
      } finally {
        if (aborts.current[tabId] === controller) delete aborts.current[tabId];
        void qc.invalidateQueries({ queryKey: ['history'] });
        refreshScratch();
      }
    },
    [qc, connectionId, openPlan, refreshScratch],
  );

  const runCurrent = useCallback(() => {
    const cur = editorApi.current?.currentSql();
    void execute(cur?.sql || tab.sql, tab.id);
  }, [execute, tab.id, tab.sql]);

  async function cancel() {
    if (run.status !== 'running') return;
    try {
      await api.post('/api/query/cancel', { executionId: run.executionId });
    } catch {
      // The local abort below is enough to stop waiting.
    }
    aborts.current[tab.id]?.abort();
  }

  const save = useCallback(() => {
    if (tab.savedId) {
      api
        .put<{ item: SavedQuery }>(`/api/saved-queries/${tab.savedId}`, {
          name: tab.title,
          sql: tab.sql,
        })
        .then(() => {
          updateTab(tab.id, { dirty: false });
          void qc.invalidateQueries({ queryKey: ['saved'] });
          flash('Consulta salva.');
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) {
            updateTab(tab.id, { savedId: undefined });
            setSaveDialog({ name: tab.title, description: '' });
          } else setSaveError(err);
        });
    } else {
      setSaveError(null);
      setSaveDialog({ name: tab.title.startsWith('Consulta ') ? '' : tab.title, description: '' });
    }
  }, [tab, qc, flash]);

  async function submitSave() {
    if (!saveDialog) return;
    try {
      const { item } = await api.post<{ item: SavedQuery }>('/api/saved-queries', {
        name: saveDialog.name.trim(),
        sql: tab.sql,
        ...(saveDialog.description.trim() ? { description: saveDialog.description.trim() } : {}),
      });
      updateTab(tab.id, { savedId: item.id, title: item.name, dirty: false });
      setSaveDialog(null);
      void qc.invalidateQueries({ queryKey: ['saved'] });
      flash('Consulta salva.');
    } catch (err) {
      setSaveError(err);
    }
  }

  function addTab(init?: Partial<EditorTab>) {
    const t = { ...newTab(tabs), ...init };
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
    return t;
  }

  function closeTab(id: string) {
    const t = tabs.find((x) => x.id === id);
    if (t?.dirty && t.sql.trim() && !window.confirm(`Fechar "${t.title}" sem salvar?`)) return;
    aborts.current[id]?.abort();
    setTabs((ts) => {
      const rest = ts.filter((x) => x.id !== id);
      const next = rest.length > 0 ? rest : [newTab([])];
      if (id === activeId) setActiveId(next[Math.max(0, ts.findIndex((x) => x.id === id) - 1)]!.id);
      return next;
    });
  }

  // Open requests from History / Saved queries.
  const lastNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!openRequest || openRequest.nonce === lastNonce.current) return;
    lastNonce.current = openRequest.nonce;
    const existing = openRequest.savedId
      ? tabs.find((t) => t.savedId === openRequest.savedId)
      : undefined;
    const target = existing
      ? (updateTab(existing.id, { sql: openRequest.sql }), setActiveId(existing.id), existing)
      : addTab({
          sql: openRequest.sql,
          ...(openRequest.title ? { title: openRequest.title } : {}),
          ...(openRequest.savedId ? { savedId: openRequest.savedId } : {}),
        });
    if (openRequest.run) void execute(openRequest.sql, target.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openRequest]);

  // A plan the server prepared (assisted rollback): opened only on its own connection, once.
  const lastPlanNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!planRequest || planRequest.nonce === lastPlanNonce.current) return;
    if (planRequest.connectionId !== connectionId) return;
    lastPlanNonce.current = planRequest.nonce;
    // Opened again while still in memory: the same entry (same idempotency key), never a new one.
    const known = getPendingPlan(planRequest.plan.planId);
    if (known) {
      if (tabs.some((x) => x.id === known.tabId)) setActiveId(known.tabId);
      setMutation(known);
      return;
    }
    const t = addTab({
      sql: planRequest.sql,
      ...(planRequest.title ? { title: planRequest.title } : {}),
    });
    openPlan(t.id, planRequest.sql, planRequest.plan, planRequest.connectionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planRequest, connectionId]);

  // The plan of this tab still in memory (dropped on a final outcome, its TTL or logout).
  const pending = usePendingPlan(
    run.status === 'mutation' && mutation === null ? run.planId : undefined,
  );
  const reopen = pending
    ? {
        onReopen: () => {
          const p = getPendingPlan(pending.planId);
          if (p && p.connectionId === connectionId) setMutation(p);
        },
        ...(pending.connectionId !== connectionId
          ? { blockedReason: 'Selecione a conexão em que a prévia foi gerada para reabri-la.' }
          : {}),
      }
    : undefined;

  function openTableQuery(sql: string) {
    if (tab.sql.trim() === '' || !tab.dirty) {
      updateTab(tab.id, { sql });
      void execute(sql, tab.id);
    } else {
      const t = addTab({ sql });
      void execute(sql, t.id);
    }
  }

  /** A saved query from the picker: a new tab, or the tab that already holds it (left as is). */
  function openSaved(q: SavedQuery) {
    setPickerOpen(false);
    const existing = tabs.find((t) => t.savedId === q.id);
    if (existing) setActiveId(existing.id);
    else addTab({ sql: q.sql, title: q.name, savedId: q.id });
  }

  function startSchemaDrag(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = schemaWidth;
    let width = startWidth;
    const move = (ev: PointerEvent) => {
      width = clampSchemaWidth(startWidth + ev.clientX - startX);
      setSchemaWidth(width);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      // Persisted once per drag, not on every move.
      if (width !== startWidth) saveSchemaWidth(width);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function schemaResizeKey(e: React.KeyboardEvent) {
    const steps: Record<string, number> = {
      ArrowLeft: schemaWidth - SCHEMA_WIDTH_STEP,
      ArrowRight: schemaWidth + SCHEMA_WIDTH_STEP,
      Home: SCHEMA_WIDTH_MIN,
      End: schemaWidthMax(),
    };
    const next = steps[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const width = clampSchemaWidth(next);
    setSchemaWidth(width);
    saveSchemaWidth(width);
  }

  function startSplitDrag(e: React.PointerEvent) {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: PointerEvent) => {
      const pct = ((ev.clientY - box.top) / box.height) * 100;
      setEditorHeight(Math.max(15, Math.min(85, pct)));
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  const labelCls = 'max-lg:sr-only';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-line bg-panel px-1.5 py-0.5">
        <button
          type="button"
          className="tbtn px-1"
          onClick={() => setShowSchema((s) => !s)}
          aria-pressed={showSchema}
          aria-label="Painel de tabelas"
          title="Mostrar/ocultar o painel de tabelas"
        >
          <Icon name="sidebar" />
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <button
          type="button"
          className="tbtn tbtn-primary"
          onClick={runCurrent}
          disabled={run.status === 'running' || run.status === 'previewing' || !connectionId}
          title={
            connectionId
              ? 'Executar (Ctrl+Enter / F5). SELECT executa direto; alterações só após prévia e confirmação.'
              : 'Selecione uma conexão para executar (ambiente indisponível)'
          }
          data-testid="run-query"
        >
          <Icon name="play" size={12} />
          <span>Executar</span>
        </button>
        <button
          type="button"
          className="tbtn"
          onClick={() => void cancel()}
          disabled={run.status !== 'running'}
          aria-label="Cancelar execução"
          title="Cancelar a consulta em execução"
        >
          <Icon name="stop" size={12} className="text-danger" />
          <span className={labelCls}>Cancelar</span>
        </button>
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        <button
          type="button"
          className="tbtn"
          onClick={() => addTab()}
          title="Nova consulta em nova aba"
        >
          <Icon name="plus" />
          <span className={labelCls}>Nova consulta</span>
        </button>
        <button type="button" className="tbtn" onClick={save} title="Salvar consulta (Ctrl+S)">
          <Icon name="save" />
          <span className={labelCls}>Salvar</span>
        </button>
        <button
          type="button"
          className="tbtn"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          aria-label="Abrir consultas salvas"
          title="Abrir uma consulta salva em nova aba"
        >
          <Icon name="folder" />
          <span className={labelCls}>Consultas salvas</span>
        </button>
        <span className="ml-2 min-w-0 truncate text-[11px] text-muted max-md:hidden">
          SELECT executa direto · alterações só após prévia e confirmação
        </span>
        {notice && (
          <span role="status" className="ml-2 text-[11px] text-ok">
            {notice}
          </span>
        )}
        <span
          className="ml-auto truncate pl-2 text-[11px] text-muted max-xl:hidden"
          title="Ctrl+Enter/F5 executa a instrução sob o cursor (ou a seleção) · Ctrl+Space sugere tabelas e colunas · Ctrl+S salva"
        >
          Ctrl+Enter executa · Ctrl+Space sugere · Ctrl+S salva
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {showSchema && (
          <>
            <aside
              className="shrink-0 overflow-hidden bg-panel"
              style={{ width: schemaWidth }}
              aria-label="Schema"
              data-testid="schema-panel"
            >
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <SchemaTree
                    tables={schema.data?.catalog.tables}
                    loading={schema.isPending && connectionReady}
                    onSelectQuery={openTableQuery}
                    onInsertText={(text) => editorApi.current?.insertText(text)}
                    loadTable={loadTable}
                    degraded={schema.data?.catalog.degraded}
                    onRefresh={connectionId ? () => refresh.mutate(connectionId) : undefined}
                    refreshing={refresh.isPending}
                    {...(scratchSchema ? { scratch: scratchSchema } : {})}
                  />
                </div>
                {schema.isError && <ErrorBox error={schema.error} className="m-2" />}
              </div>
            </aside>
            <div
              className="w-1 shrink-0 cursor-col-resize border-x border-line bg-panel2 hover:bg-accent/30 focus-visible:bg-accent/30"
              onPointerDown={startSchemaDrag}
              onKeyDown={schemaResizeKey}
              role="separator"
              aria-orientation="vertical"
              aria-label="Redimensionar painel de tabelas"
              aria-valuemin={SCHEMA_WIDTH_MIN}
              aria-valuemax={schemaWidthMax()}
              aria-valuenow={schemaWidth}
              tabIndex={0}
              data-testid="schema-resizer"
            />
          </>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
          {/* Editor tabs */}
          <div
            className="flex items-end gap-px overflow-x-auto border-b border-line bg-panel2 px-1 pt-0.5"
            role="tablist"
            aria-label="Abas do editor"
          >
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`group flex shrink-0 items-center rounded-t-sm border border-b-0 text-xs ${
                  t.id === tab.id
                    ? 'border-line bg-panel font-semibold text-fg shadow-[inset_0_2px_0_var(--dbx-accent)]'
                    : 'border-transparent text-muted hover:bg-hover hover:text-fg'
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.id === tab.id}
                  className="max-w-48 truncate py-0.5 pr-1 pl-2"
                  onClick={() => setActiveId(t.id)}
                  onDoubleClick={() => {
                    const name = window.prompt('Nome da aba', t.title);
                    if (name?.trim()) updateTab(t.id, { title: name.trim().slice(0, 120) });
                  }}
                  title={t.title}
                >
                  {t.dirty ? '● ' : ''}
                  {t.title}
                </button>
                <button
                  type="button"
                  className={`mr-0.5 rounded p-0.5 text-muted hover:bg-hover hover:text-fg ${
                    t.id === tab.id ? 'opacity-80' : 'opacity-50 group-hover:opacity-100'
                  }`}
                  onClick={() => closeTab(t.id)}
                  aria-label={`Fechar aba ${t.title}`}
                  title="Fechar aba"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            ))}
            <button
              type="button"
              className="mb-0.5 ml-0.5 rounded p-1 text-muted hover:bg-hover hover:text-fg"
              onClick={() => addTab()}
              aria-label="Nova aba"
              title="Nova aba"
            >
              <Icon name="plus" size={12} />
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col" ref={splitRef}>
            <div
              style={{ height: `${editorHeight}%` }}
              className="min-h-0"
              data-testid="sql-editor"
            >
              {active && (
                <SqlEditor
                  key={tab.id}
                  path={`tab-${tab.id}.sql`}
                  value={tab.sql}
                  theme={theme}
                  onChange={(v) => updateTab(tab.id, { sql: v, dirty: true })}
                  onRun={runCurrent}
                  onSave={save}
                  apiRef={editorApi}
                />
              )}
            </div>
            <div
              className="h-1 shrink-0 cursor-row-resize border-y border-line bg-panel2 hover:bg-accent/30"
              onPointerDown={startSplitDrag}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Redimensionar editor e resultados"
            />
            <div className="min-h-0 flex-1">
              <ResultsPanel
                run={run}
                tab={resultTab[tab.id] ?? 'results'}
                onTab={(t) => setResultTab((m) => ({ ...m, [tab.id]: t }))}
                {...(reopen ? { reopen } : {})}
                {...(connectionName ? { connectionName } : {})}
              />
            </div>
          </div>
        </div>
      </div>

      <SavedQueryPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={openSaved} />

      {mutation && (
        <MutationDialog
          key={mutation.planId}
          preview={mutation.preview}
          sql={mutation.sql}
          idempotencyKey={mutation.idempotencyKey}
          {...(mutation.outcome ? { initialOutcome: mutation.outcome } : {})}
          approvalRequested={mutation.approvalRequested}
          onClose={() => setMutation(null)}
          onOutcome={(outcome) => {
            updatePlan(mutation.planId, { outcome });
            refreshScratch();
            setRun(mutation.tabId, {
              status: 'mutation',
              sql: mutation.sql,
              planId: mutation.planId,
              outcome,
            });
          }}
          onApprovalRequested={() => updatePlan(mutation.planId, { approvalRequested: true })}
          onSettled={() => dropPlan(mutation.planId)}
        />
      )}

      <Modal
        open={saveDialog !== null}
        title="Salvar consulta"
        onClose={() => setSaveDialog(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setSaveDialog(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!saveDialog?.name.trim()}
              onClick={() => void submitSave()}
              data-testid="save-confirm"
            >
              Salvar
            </button>
          </>
        }
      >
        {saveDialog && (
          <form
            className="space-y-2 text-xs"
            onSubmit={(e) => {
              e.preventDefault();
              void submitSave();
            }}
          >
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                value={saveDialog.name}
                maxLength={120}
                autoFocus
                onChange={(e) => setSaveDialog({ ...saveDialog, name: e.target.value })}
                data-testid="save-name"
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Descrição (opcional)</span>
              <textarea
                className="input h-16 w-full"
                value={saveDialog.description}
                maxLength={1000}
                onChange={(e) => setSaveDialog({ ...saveDialog, description: e.target.value })}
              />
            </label>
            <ErrorBox error={saveError} />
          </form>
        )}
      </Modal>
    </div>
  );
}
