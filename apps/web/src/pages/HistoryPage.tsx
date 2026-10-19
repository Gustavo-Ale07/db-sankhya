import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { HistoryItem } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { formatDateTime, formatDuration } from '../lib/format';
import type { OpenRequest } from '../explorer/ExplorerPage';

const PAGE = 50;

const STATUS_LABEL: Record<HistoryItem['status'], { text: string; cls: string }> = {
  success: { text: 'sucesso', cls: 'text-ok border-ok/40' },
  error: { text: 'erro', cls: 'text-danger border-danger/40' },
  cancelled: { text: 'cancelada', cls: 'text-muted' },
  preview: { text: 'preview', cls: 'text-warn border-warn/50' },
};

export function HistoryPage({ onOpen }: { onOpen: (r: Omit<OpenRequest, 'nonce'>) => void }) {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [offset, setOffset] = useState(0);

  const history = useQuery({
    queryKey: ['history', applied, offset],
    queryFn: () =>
      api.get<{ items: HistoryItem[] }>('/api/history', {
        query: { limit: PAGE, offset, search: applied || undefined },
      }),
  });

  async function clear() {
    if (!window.confirm('Apagar todo o seu histórico de consultas?')) return;
    await api.del('/api/history');
    setOffset(0);
    void qc.invalidateQueries({ queryKey: ['history'] });
  }

  const items = history.data?.items ?? [];
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Histórico de consultas</h1>
        <form
          className="flex gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(search.trim());
          }}
        >
          <label className="sr-only" htmlFor="history-search">
            Buscar no histórico
          </label>
          <input
            id="history-search"
            className="input w-64"
            placeholder="Buscar SQL…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit" className="btn">
            Buscar
          </button>
        </form>
        <button type="button" className="btn" onClick={() => void clear()} disabled={!items.length}>
          Limpar histórico
        </button>
      </div>
      <ErrorBox error={history.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="history-table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>SQL</th>
              <th>Status</th>
              <th className="text-right">Linhas</th>
              <th className="text-right">API</th>
              <th className="text-right">Tempo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((h) => (
              <tr key={h.id}>
                <td className="whitespace-nowrap">{formatDateTime(h.createdAt)}</td>
                <td className="max-w-xl">
                  <code className="line-clamp-3 font-mono break-all whitespace-pre-wrap">
                    {h.sql}
                  </code>
                  {h.errorCode && <div className="text-[11px] text-danger">{h.errorCode}</div>}
                </td>
                <td>
                  <span className={`badge ${STATUS_LABEL[h.status]?.cls ?? ''}`}>
                    {STATUS_LABEL[h.status]?.text ?? h.status}
                  </span>
                </td>
                <td className="text-right">{h.resultRows ?? h.affectedRows ?? '—'}</td>
                <td className="text-right">{h.apiCalls ?? '—'}</td>
                <td className="text-right whitespace-nowrap">{formatDuration(h.durationMs)}</td>
                <td className="whitespace-nowrap">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpen({ sql: h.sql, title: 'Do histórico' })}
                  >
                    Abrir
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onOpen({ sql: h.sql, title: 'Do histórico', run: true })}
                  >
                    Executar
                  </button>
                </td>
              </tr>
            ))}
            {!history.isPending && items.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-muted">
                  Nenhuma consulta no histórico.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2 text-xs">
        <button
          type="button"
          className="btn"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
        >
          ← Anteriores
        </button>
        <span className="text-muted">
          {items.length ? `${offset + 1}–${offset + items.length}` : '0'}
        </span>
        <button
          type="button"
          className="btn"
          disabled={items.length < PAGE}
          onClick={() => setOffset((o) => o + PAGE)}
        >
          Próximas →
        </button>
      </div>
    </div>
  );
}
