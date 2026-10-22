import { useEffect, useMemo, useState } from 'react';
import { translateMessage } from '../api/errors';
import type { QueryResult } from '../api/types';
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
import { REPORT_STATUS_TEXT } from './runState';
import type { MutationOutcome, RunState } from './runState';

export type ResultTab = 'results' | 'json' | 'messages';

const TABS: { id: ResultTab; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'json', label: 'JSON' },
  { id: 'messages', label: 'Messages' },
];

/** A plan of this tab still held in memory, which the status area can reopen. */
export interface ReopenPlan {
  onReopen: () => void;
  /** Why it cannot be reopened right now (another connection is selected). */
  blockedReason?: string;
}

interface Props {
  run: RunState;
  tab: ResultTab;
  onTab: (t: ResultTab) => void;
  reopen?: ReopenPlan;
  /** Name of the selected connection, shown next to a result read from Sankhya. */
  connectionName?: string;
}

/** Where a result was read: the Sankhya gateway, the caller's tmp_ tables, or both. */
const ORIGIN: Record<NonNullable<QueryResult['source']>, { label: string; title: string }> = {
  sankhya: { label: 'Sankhya', title: 'Lido do Sankhya pelo gateway' },
  scratch: {
    label: 'temporária',
    title: 'Lido só das suas tabelas tmp_* (scratch), sem chamar o gateway',
  },
  hybrid: {
    label: 'híbrido',
    title: 'Partes lidas do Sankhya, copiadas para o scratch e cruzadas com suas tabelas tmp_*',
  },
};

function ResultOrigin({
  result,
  connectionName,
}: {
  result: QueryResult;
  connectionName?: string;
}) {
  if (!result.source) return null;
  const origin = ORIGIN[result.source];
  return (
    <>
      <span className="badge font-semibold" data-testid="result-origin" title={origin.title}>
        {origin.label}
      </span>
      {result.source !== 'scratch' && connectionName && (
        <span data-testid="result-connection">Conexão: {connectionName}</span>
      )}
      {result.hybrid && (
        <span data-testid="result-hybrid-parts" title="Partes do Sankhya copiadas para o scratch">
          {result.hybrid.parts
            .map(
              (p) => `${p.tables.join(', ')}: ${p.rows} linha(s)${p.truncated ? ' (cortado)' : ''}`,
            )
            .join(' · ')}
        </span>
      )}
    </>
  );
}

function ReopenButton({ reopen }: { reopen: ReopenPlan }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn"
        onClick={reopen.onReopen}
        disabled={reopen.blockedReason !== undefined}
        data-testid="mutation-reopen"
      >
        Reabrir prévia
      </button>
      {reopen.blockedReason !== undefined && (
        <span className="text-muted" data-testid="mutation-reopen-blocked">
          {reopen.blockedReason}
        </span>
      )}
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, []);
  return <>{formatDuration(now - since)}</>;
}

/**
 * What the results area says about a mutation plan, also after its dialog closed. Once an execute
 * was sent it never claims that nothing was written; an unknown outcome keeps a do-not-repeat
 * banner until the tab runs something else.
 */
export function MutationStatus({
  outcome,
  reopen,
}: {
  outcome?: MutationOutcome;
  reopen?: ReopenPlan;
}) {
  if (!outcome) {
    return (
      <div className="space-y-2">
        <p>
          Instrução de alteração: revise a prévia. Nada é gravado sem a confirmação explícita no
          diálogo.
        </p>
        {reopen && <ReopenButton reopen={reopen} />}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {outcome.unknown && (
        <div
          role="alert"
          className="rounded border border-danger bg-danger/10 px-3 py-2 font-semibold text-danger"
          data-testid="mutation-outcome-unknown"
        >
          NÃO repita esta alteração. Ela pode ter sido gravada, mas o resultado não foi confirmado
          {outcome.errorCode ? ` [${outcome.errorCode}]` : ''}. Confira os registros no Sankhya
          antes de qualquer nova tentativa.
        </div>
      )}
      {outcome.report ? (
        <p>
          Alteração executada ({REPORT_STATUS_TEXT[outcome.report.status]}). Verificação:{' '}
          <strong>{outcome.report.verification}</strong>.
        </p>
      ) : outcome.unknown ? null : (
        <p>
          Execução recusada pelo servidor
          {outcome.errorCode ? <span className="font-mono"> [{outcome.errorCode}]</span> : null}.
          Nada foi gravado.
        </p>
      )}
      {reopen && <ReopenButton reopen={reopen} />}
    </div>
  );
}

export function ResultsPanel({ run, tab, onTab, reopen, connectionName }: Props) {
  const result = run.status === 'result' ? run.result : null;
  const columnNames = useMemo(() => result?.columns.map((c) => c.name) ?? [], [result]);
  const records = useMemo(
    () => (result ? toJsonRecords(columnNames, result.rows) : undefined),
    [result, columnNames],
  );

  const messages: string[] = [];
  if (run.status === 'result') {
    messages.push(...run.result.messages.map(translateMessage));
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
      <div
        className="flex items-end gap-px border-b border-line bg-panel2 px-1 pt-0.5"
        role="tablist"
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`rounded-t-sm border border-b-0 px-2.5 py-0.5 text-xs ${
              tab === t.id
                ? 'border-line bg-panel font-semibold text-fg shadow-[inset_0_2px_0_var(--dbx-accent)]'
                : 'border-transparent text-muted hover:bg-hover hover:text-fg'
            }`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
            {t.id === 'messages' && messages.length > 0 ? ` (${messages.length})` : ''}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-0.5 self-center pr-1">
          {result && result.columns.length > 0 && (
            <>
              <button
                type="button"
                className="tbtn py-0 text-[11px]"
                onClick={() => void navigator.clipboard.writeText(toTsv(columnNames, result.rows))}
                title="Copiar tudo (TSV, cola em planilhas)"
              >
                Copiar
              </button>
              <button type="button" className="tbtn py-0 text-[11px]" onClick={exportCsv}>
                CSV
              </button>
              <button type="button" className="tbtn py-0 text-[11px]" onClick={exportJson}>
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
              <div className="p-2 text-xs text-muted">
                Execute uma consulta com Ctrl+Enter ou F5. Experimente:{' '}
                <code>SELECT CODPARC, NOMEPARC FROM TGFPAR</code>
              </div>
            )}
            {run.status === 'running' && (
              <div className="p-2 text-xs text-muted" role="status">
                Executando… <Elapsed since={run.startedAt} />
              </div>
            )}
            {run.status === 'error' && <ErrorBox error={run.error} className="m-2" />}
            {run.status === 'previewing' && (
              <div className="p-2 text-xs text-muted" role="status">
                Instrução de alteração: preparando a prévia. Nada foi executado.
              </div>
            )}
            {run.status === 'mutation' && (
              <div className="p-2 text-xs" role="status" data-testid="mutation-status">
                <MutationStatus
                  {...(run.outcome ? { outcome: run.outcome } : {})}
                  {...(reopen ? { reopen } : {})}
                />
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
          <div className="space-y-1 p-2 text-xs" data-testid="messages">
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
        className="flex min-h-5 flex-wrap items-center gap-x-4 border-t border-line bg-panel2 px-2 text-[11px] text-muted"
        data-testid="result-status"
      >
        {result && (
          <>
            <ResultOrigin result={result} {...(connectionName ? { connectionName } : {})} />
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
