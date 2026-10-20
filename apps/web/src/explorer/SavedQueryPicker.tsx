import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { SavedQuery } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Icon } from '../components/Icon';
import { Modal } from '../components/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (query: SavedQuery) => void;
}

/** Picks one of the user's saved queries (same list and cache as the "Consultas salvas" page). */
export function SavedQueryPicker({ open, onClose, onPick }: Props) {
  return (
    <Modal open={open} title="Consultas salvas" onClose={onClose} testId="saved-picker">
      <PickerBody onPick={onPick} />
    </Modal>
  );
}

function PickerBody({ onPick }: { onPick: (query: SavedQuery) => void }) {
  const [filter, setFilter] = useState('');
  const saved = useQuery({
    queryKey: ['saved'],
    queryFn: () => api.get<{ items: SavedQuery[] }>('/api/saved-queries'),
  });

  const f = filter.trim().toLowerCase();
  const items = (saved.data?.items ?? []).filter(
    (q) =>
      !f ||
      q.name.toLowerCase().includes(f) ||
      q.sql.toLowerCase().includes(f) ||
      (q.description ?? '').toLowerCase().includes(f),
  );

  return (
    <div className="space-y-2 text-xs">
      <div className="relative">
        <label className="sr-only" htmlFor="saved-picker-filter">
          Filtrar consultas salvas
        </label>
        <Icon
          name="search"
          size={12}
          className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-muted"
        />
        <input
          id="saved-picker-filter"
          className="input input-search w-full"
          placeholder="Filtrar por nome, descrição ou SQL…"
          value={filter}
          autoFocus
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && items[0]) {
              e.preventDefault();
              onPick(items[0]);
            }
          }}
        />
      </div>
      <ErrorBox error={saved.error} />
      {saved.isPending && <p className="text-muted">Carregando…</p>}
      <ul
        className="max-h-[55vh] divide-y divide-line overflow-auto rounded border border-line"
        aria-label="Consultas salvas"
        data-testid="saved-picker-list"
      >
        {items.map((q) => (
          <li key={q.id}>
            <button
              type="button"
              className="flex w-full flex-col items-start gap-0.5 px-2 py-1.5 text-left hover:bg-hover"
              onClick={() => onPick(q)}
              title="Abrir em nova aba"
              data-testid="saved-picker-item"
            >
              <span className="font-semibold">{q.name}</span>
              {q.description && <span className="text-[11px] text-muted">{q.description}</span>}
              <span className="w-full truncate font-mono text-[11px] text-muted">{q.sql}</span>
            </button>
          </li>
        ))}
      </ul>
      {!saved.isPending && !saved.isError && items.length === 0 && (
        <p className="text-muted">
          {f ? 'Nenhuma consulta corresponde ao filtro.' : 'Nenhuma consulta salva ainda.'}
        </p>
      )}
    </div>
  );
}
