import { useEffect, useMemo, useState } from 'react';
import { ErrorBox } from '../components/ErrorBox';
import { JsonView } from '../components/JsonView';
import {
  downloadText,
  formatDuration,
  timestampForFile,
  toCsv,
  toJsonRecords,
  toTsv,
} from '../lib/format';
import { ResultGrid } from './ResultGrid';
import type { RunState } from './runState';

export type ResultTab = 'results' | 'json' | 'messages';

const TABS: { id: ResultTab; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'json', label: 'JSON' },
  { id: 'messages', label: 'Messages' },
];

interface Props {
  run: RunState;
  tab: ResultTab;
  onTab: (t: ResultTab) => void;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return <>{formatDuration(now - since)}</>;
}

export function ResultsPanel({ run, tab, onTab }: Props) {
  const result = run.status === 'result' ? run.result : null;
  const columnNames = useMemo(() => result?.columns.map((c) => c.name) ?? [], [result]);
  const records = useMemo(
    () => (result ? toJsonRecords(columnNames, result.rows) : undefined),
    [result, columnNames],
  );

  const messages: string[] = [];
  if (run.status === 'result') {
    messages.push(...run.result.messages);
    if (run.result.truncated)
      messages.push(
        `Resultado truncado: exibindo ${run.result.rowCount} linha(s) pelo limite de linhas. Use filtros para refinar.`,
      );
  }

  function exportCsv() {
    if (!result) return;
    downloadText(
      `${result.resource ?? 'resultado'}-${timestampForFile()}.csv`,
      `\uFEFF${toCsv(columnNames, result.rows)}`,
      'text/csv;charset=utf-8',
    );
  }
  function exportJson() {
    if (!result) return;
    downloadText(
      `${result.resource ?? 'resultado'}-${timestampForFile()}.json`,
      JSON.stringify(records, null, 2),
      'application/json',
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-panel" aria-label="Resultados">
      <div className="flex items-center gap-0.5 border-b border-line bg-panel2 px-1" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`px-3 py-1.5 text-xs ${
              tab === t.id ? 'border-b-2 border-accent font-semibold' : 'text-muted hover:text-fg'
            }`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === 'messages' && messages.length > 0 ? ` (${messages.length})` : ''}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-1 pr-1">
          {result && result.columns.length > 0 && (
            <>
              <button
                type="button"
                className="btn"
                onClick={() => void navigator.clipboard.writeText(toTsv(columnNames, result.rows))}
                title="Copiar tudo (TSV, cola em planilhas)"
              >
                Copiar
              </button>
              <button type="button" className="btn" onClick={exportCsv}>
                CSV
              </button>
              <button type="button" className="btn" onClick={exportJson}>
                JSON
              </button>
            </>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1" role="tabpanel">
        {tab === 'results' && (
          <>
            {run.status === 'idle' && (
              <div className="p-3 text-xs text-muted">
                Execute uma consulta com Ctrl+Enter ou F5. Experimente:{' '}
                <code>SELECT CODPARC, NOMEPARC FROM TGFPAR</code>
              </div>
            )}
            {run.status === 'running' && (
              <div className="p-3 text-xs text-muted" role="status">
                Executando… <Elapsed since={run.startedAt} />
              </div>
            )}
            {run.status === 'error' && <ErrorBox error={run.error} className="m-3" />}
            {run.status === 'previewing' && (
              <div className="p-3 text-xs text-muted" role="status">
                Instrução de alteração: preparando a prévia. Nada foi executado.
              </div>
            )}
            {run.status === 'mutation' && (
              <div className="p-3 text-xs" role="status" data-testid="mutation-status">
                {run.report ? (
                  <>
                    Alteração executada ({run.report.status}). Verificação:{' '}
                    <strong>{run.report.verification}</strong>.
                  </>
                ) : (
                  <>
                    Instrução de alteração: revise a prévia. Nada é gravado sem a confirmação
                    explícita no diálogo.
                  </>
                )}
              </div>
            )}
            {result && (
              <ResultGrid
                columns={result.columns}
                rows={result.rows}
                resultKey={result.executionId}
              />
            )}
          </>
        )}
        {tab === 'json' && (
          <JsonView value={records} emptyText="Sem resultado." testId="result-json" />
        )}
        {tab === 'messages' && (
          <div className="space-y-1 p-3 text-xs" data-testid="messages">
            {messages.length === 0 && run.status !== 'error' && (
              <p className="text-muted">Nenhuma mensagem.</p>
            )}
            {messages.map((m, i) => (
              <p key={i}>• {m}</p>
            ))}
            {run.status === 'error' && <ErrorBox error={run.error} />}
          </div>
        )}
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 border-t border-line bg-panel2 px-2 py-0.5 text-[11px] text-muted"
        data-testid="result-status"
      >
        {result && (
          <>
            <span>
              <strong className="text-fg">{result.rowCount}</strong> linha(s)
            </span>
            <span data-testid="result-duration" title="Tempo de execução no servidor">
              Tempo: {formatDuration(result.durationMs)}
            </span>
            <span>{result.apiCalls} chamada(s) ao gateway</span>
            {result.truncated && (
              <span
                className="badge border-warn/60 font-semibold text-warn"
                data-testid="truncated"
                title="O resultado atingiu o limite de linhas e está incompleto"
              >
                truncado
              </span>
            )}
          </>
        )}
        {run.status === 'error' && <span className="text-danger">Falhou</span>}
        {run.status === 'running' && <span>Executando…</span>}
      </div>
    </section>
  );
}
