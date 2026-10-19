import type { ConnectionOption } from '../api/types';
import { ENVIRONMENT_LABEL } from '../components/EnvironmentBanner';

interface Props {
  connections: readonly ConnectionOption[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  loading?: boolean;
}

export function ConnectionPicker({ connections, selectedId, onSelect, loading }: Props) {
  if (connections.length === 0) {
    return (
      <span className="text-[11px] text-muted" data-testid="connection-empty">
        {loading ? 'Carregando conexões…' : 'Nenhuma conexão disponível'}
      </span>
    );
  }
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="text-muted">Conexão</span>
      <select
        className="input py-0.5 text-xs"
        value={selectedId ?? ''}
        onChange={(e) => onSelect(e.target.value)}
        data-testid="connection-picker"
      >
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({ENVIRONMENT_LABEL[c.environment]})
          </option>
        ))}
      </select>
    </label>
  );
}
