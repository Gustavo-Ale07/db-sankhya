import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SavedQuery } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { formatDateTime } from '../lib/format';
import type { OpenRequest } from '../explorer/ExplorerPage';

interface Draft {
  id?: string;
  name: string;
  description: string;
  sql: string;
}

export function SavedQueriesPage({ onOpen }: { onOpen: (r: Omit<OpenRequest, 'nonce'>) => void }) {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<unknown>(null);
  const saved = useQuery({
    queryKey: ['saved'],
    queryFn: () => api.get<{ items: SavedQuery[] }>('/api/saved-queries'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['saved'] });

  async function submit() {
    if (!draft) return;
    setError(null);
    const body = {
      name: draft.name.trim(),
      sql: draft.sql,
      description: draft.description.trim() || null,
    };
    try {
      if (draft.id) await api.put(`/api/saved-queries/${draft.id}`, body);
      else await api.post('/api/saved-queries', body);
      setDraft(null);
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  const f = filter.trim().toLowerCase();
  const items = (saved.data?.items ?? []).filter(
    (q) =>
      !f ||
      q.name.toLowerCase().includes(f) ||
      q.sql.toLowerCase().includes(f) ||
      (q.description ?? '').toLowerCase().includes(f),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Consultas salvas</h1>
        <label className="sr-only" htmlFor="saved-filter">
          Filtrar consultas
        </label>
        <input
          id="saved-filter"
          className="input w-64"
          placeholder="Filtrar…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setError(null);
            setDraft({ name: '', description: '', sql: 'SELECT CODPROD, DESCRPROD FROM TGFPRO' });
          }}
        >
          Nova consulta
        </button>
      </div>
      {!draft && <ErrorBox error={error ?? saved.error} />}
      <div className="grid gap-2" data-testid="saved-list">
        {items.map((q) => (
          <article key={q.id} className="rounded border border-line bg-panel p-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="mr-auto min-w-0">
                <h2 className="font-semibold">{q.name}</h2>
                {q.description && <p className="text-xs text-muted">{q.description}</p>}
                <p className="text-[11px] text-muted">
                  Atualizada em {formatDateTime(q.updatedAt)}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => onOpen({ sql: q.sql, title: q.name, savedId: q.id, run: true })}
                >
                  Executar
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => onOpen({ sql: q.sql, title: q.name, savedId: q.id })}
                >
                  Abrir no editor
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setError(null);
                    setDraft({
                      id: q.id,
                      name: q.name,
                      description: q.description ?? '',
                      sql: q.sql,
                    });
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void act(() => api.post(`/api/saved-queries/${q.id}/duplicate`))}
                >
                  Duplicar
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    if (window.confirm(`Excluir a consulta "${q.name}"?`))
                      void act(() => api.del(`/api/saved-queries/${q.id}`));
                  }}
                >
                  Excluir
                </button>
              </div>
            </div>
            <pre className="mt-2 max-h-40 overflow-auto rounded bg-panel2 p-2 font-mono text-xs whitespace-pre-wrap">
              {q.sql}
            </pre>
          </article>
        ))}
        {!saved.isPending && items.length === 0 && (
          <p className="text-xs text-muted">
            Nenhuma consulta salva. No editor, use Ctrl+S para salvar a aba atual.
          </p>
        )}
      </div>

      <Modal
        open={draft !== null}
        title={draft?.id ? 'Editar consulta' : 'Nova consulta'}
        onClose={() => setDraft(null)}
        wide
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDraft(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!draft?.name.trim() || !draft.sql.trim()}
              onClick={() => void submit()}
            >
              Salvar
            </button>
          </>
        }
      >
        {draft && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                value={draft.name}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Descrição</span>
              <input
                className="input w-full"
                value={draft.description}
                maxLength={1000}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">SQL</span>
              <textarea
                className="input h-48 w-full font-mono"
                value={draft.sql}
                onChange={(e) => setDraft({ ...draft, sql: e.target.value })}
                spellCheck={false}
              />
            </label>
            <ErrorBox error={error} />
          </div>
        )}
      </Modal>
    </div>
  );
}
