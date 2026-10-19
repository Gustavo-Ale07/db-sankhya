import type { Meta } from '../api/types';

export function Footer({ meta }: { meta: Meta | undefined }) {
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line bg-panel px-3 py-1 text-[11px] text-muted">
      <span data-testid="app-version">
        DB-Sankhya v{meta?.version ?? '—'}
        {meta?.commit && meta.commit !== 'unknown' ? ` · ${meta.commit.slice(0, 7)}` : ''}
      </span>
      {meta && (
        <span data-testid="sankhya-mode">
          Modo Sankhya:{' '}
          <strong className={meta.sankhyaMode === 'live' ? 'text-warn' : 'text-ok'}>
            {meta.sankhyaMode === 'live' ? 'LIVE' : 'MOCK (dados fictícios)'}
          </strong>
        </span>
      )}
      <span className="ml-auto">
        DB-Sankhya é uma ferramenta independente, sem afiliação com a Sankhya Gestão de Negócios.
      </span>
    </footer>
  );
}
