import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError } from '../api/client';
import { describeError } from '../api/errors';
import { executePlan, requestApproval } from '../api/mutations';
import type {
  ExecutionReport,
  ExecutionStep,
  MutationPreview,
  PreviewTarget,
  StepOutcome,
  VerificationLabel,
} from '../api/mutations';
import type { Value } from '../api/types';
import {
  PREVIEW_KIND_LABEL,
  confirmationMatches,
  formatCountdown,
  previewLabelsOf,
  remainingSeconds,
} from './runState';

const VERIFICATION_TEXT: Record<VerificationLabel, string> = {
  VERIFIED: 'Todas as alterações foram lidas de volta e conferem.',
  PARTIALLY_VERIFIED: 'Só parte das alterações pôde ser lida de volta e conferida.',
  UNVERIFIED: 'Nenhuma alteração pôde ser conferida por leitura.',
  FAILED: 'A leitura de volta encontrou valores diferentes do esperado.',
};

const VERIFICATION_TONE: Record<VerificationLabel, string> = {
  VERIFIED: 'border-ok/60 text-ok',
  PARTIALLY_VERIFIED: 'border-warn/60 text-warn',
  UNVERIFIED: 'border-warn/60 text-warn',
  FAILED: 'border-danger/60 text-danger',
};

const STATUS_TEXT: Record<ExecutionReport['status'], string> = {
  success: 'concluída',
  partial: 'parcial',
  failed: 'falhou',
};

const OUTCOME_TEXT: Record<StepOutcome, string> = {
  ok: 'gravado',
  error: 'erro',
  not_attempted: 'não tentado',
  unknown: 'resultado desconhecido',
};

/**
 * Refusals after which this plan can no longer run: retrying with it is pointless, a new
 * preview is needed. Any other failure keeps the button (the retry reuses the idempotency key).
 */
const PLAN_DEAD = new Set([
  'CONFIRMATION_EXPIRED',
  'CONFIRMATION_USED',
  'CONFIRMATION_INVALID',
  'TARGETS_CHANGED',
  'READ_ONLY_MODE',
  'WRITE_OUTCOME_UNKNOWN',
]);

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function show(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function keyText(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k}=${show(v)}`)
    .join(', ');
}

function Diff({ targets }: { targets: PreviewTarget[] }) {
  if (targets.length === 0) return <p className="text-muted">Nenhum registro afetado.</p>;
  return (
    <div className="max-h-64 overflow-auto rounded border border-line">
      <table className="w-full text-[11px]" data-testid="mutation-diff">
        <thead className="bg-panel2 text-left">
          <tr>
            <th className="px-2 py-1">Chave</th>
            <th className="px-2 py-1">Coluna</th>
            <th className="px-2 py-1">Antes</th>
            <th className="px-2 py-1">Depois</th>
          </tr>
        </thead>
        <tbody>
          {targets.flatMap((t, i) => {
            const cols = [...new Set([...Object.keys(t.before ?? {}), ...Object.keys(t.after)])];
            const changed = cols.filter(
              (c) => t.before === null || show(t.before[c]) !== show(t.after[c]),
            );
            const rows = changed.length > 0 ? changed : cols.slice(0, 1);
            return rows.map((c, j) => (
              <tr key={`${i}-${c}`} className="border-t border-line align-top">
                <td className="px-2 py-1 font-mono">{j === 0 ? keyText(t.key) || '—' : ''}</td>
                <td className="px-2 py-1 font-mono">{c}</td>
                <td className="px-2 py-1 font-mono text-danger">
                  {t.before === null ? '(novo registro)' : show(t.before[c] as Value)}
                </td>
                <td className="px-2 py-1 font-mono text-ok">{show(t.after[c] as Value)}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}

function Report({ report }: { report: ExecutionReport }) {
  const unknown = report.steps.some((s) => s.outcome === 'unknown');
  return (
    <div className="space-y-2" data-testid="execution-report">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Execução {STATUS_TEXT[report.status]}</span>
        <span
          className={`badge font-semibold ${VERIFICATION_TONE[report.verification]}`}
          data-testid="verification-status"
        >
          {report.verification}
        </span>
        <span className="text-muted">{VERIFICATION_TEXT[report.verification]}</span>
      </div>
      {unknown && <UnknownWarning />}
      <table className="w-full text-[11px]" data-testid="execution-steps">
        <thead className="bg-panel2 text-left">
          <tr>
            <th className="px-2 py-1">#</th>
            <th className="px-2 py-1">Chave</th>
            <th className="px-2 py-1">Resultado</th>
            <th className="px-2 py-1">Conferido</th>
          </tr>
        </thead>
        <tbody>
          {report.steps.map((s: ExecutionStep, i) => (
            <tr key={i} className="border-t border-line" data-testid="execution-step">
              <td className="px-2 py-1">{i + 1}</td>
              <td className="px-2 py-1 font-mono">{keyText(s.key) || '—'}</td>
              <td className="px-2 py-1">
                {OUTCOME_TEXT[s.outcome] ?? s.outcome}
                {s.errorCode && <span className="ml-1 font-mono text-danger">[{s.errorCode}]</span>}
              </td>
              <td className="px-2 py-1">
                {s.verified === true ? 'sim' : s.verified === false ? 'não confere' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnknownWarning() {
  return (
    <div
      role="alert"
      className="rounded border border-danger bg-danger/10 px-3 py-2 font-semibold text-danger"
      data-testid="outcome-unknown"
    >
      NÃO repita esta operação. A alteração pode ter sido gravada, mas o resultado não pôde ser
      confirmado. Confira os registros no Sankhya antes de qualquer nova tentativa.
    </div>
  );
}

function Refusal({ error }: { error: unknown }) {
  const e = describeError(error);
  return (
    <div
      role="alert"
      className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
      data-testid="mutation-error"
    >
      <div className="font-semibold">
        {e.title} <span className="font-mono text-xs opacity-80">[{e.code}]</span>
      </div>
      {e.detail && <div className="mt-0.5 text-xs text-fg/80">{e.detail}</div>}
    </div>
  );
}

interface Props {
  preview: MutationPreview;
  sql: string;
  onClose: () => void;
  onExecuted?: (report: ExecutionReport) => void;
  /** Idempotency key factory; one key per dialog (per plan), reused by every retry. */
  newKey?: () => string;
}

/**
 * Preview, confirmation and execution of one mutation plan. Opening it never writes: only the
 * explicit "Executar" click calls /api/query/execute. The plan token stays in this component's
 * memory and is never stored or logged.
 */
export function MutationDialog({ preview, sql, onClose, onExecuted, newKey }: Props) {
  const titleId = useId();
  const confirmId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // One key per plan: a double click or a retry after a lost answer never executes twice.
  const [idempotencyKey] = useState(() => (newKey ?? (() => crypto.randomUUID()))());
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [approval, setApproval] = useState<'none' | 'requesting' | 'requested'>('none');
  const [approvalError, setApprovalError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());

  const remaining = remainingSeconds(preview.expiresAt, now);
  const expired = remaining <= 0;
  const phrase = preview.requires.strongConfirmation;
  const matches = confirmationMatches(typed, phrase);
  const errorCode = error instanceof ApiError ? error.code : null;
  const outcomeUnknown = errorCode === 'WRITE_OUTCOME_UNKNOWN';
  const planDead = errorCode !== null && PLAN_DEAD.has(errorCode);
  const canExecute = !busy && !expired && matches && report === null && !planDead;

  useEffect(() => {
    if (report) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [report]);

  // Focus moves into the dialog on open and back to where it was on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? ref.current)?.focus();
    return () => previous?.focus?.();
  }, []);

  // A button that got disabled drops focus to the page: bring it back into the dialog.
  useEffect(() => {
    const d = ref.current;
    if (!busy && d && !d.contains(document.activeElement)) d.focus();
  }, [busy, report, error]);

  const close = useCallback(() => {
    if (!inFlight.current) onClose();
  }, [onClose]);

  // Esc closes from anywhere (focus may sit on a button that just got disabled), except while
  // a write is in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function execute() {
    if (inFlight.current || !canExecute) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const res = await executePlan({
        planId: preview.planId,
        token: preview.token,
        idempotencyKey,
        ...(phrase !== null ? { strongConfirmation: typed } : {}),
      });
      setReport(res);
      onExecuted?.(res);
    } catch (err) {
      setError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function askApproval() {
    if (approval !== 'none') return;
    setApproval('requesting');
    setApprovalError(null);
    try {
      await requestApproval(preview.planId);
      setApproval('requested');
    } catch (err) {
      setApprovalError(err);
      setApproval('none');
    }
  }

  const labels = previewLabelsOf(preview);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-[95vw] max-w-4xl flex-col rounded-lg border border-line bg-panel text-fg shadow-xl"
        data-testid="mutation-dialog"
      >
        <div className="flex items-center border-b border-line px-4 py-2">
          <h2 id={titleId} className="font-semibold">
            Prévia da alteração
          </h2>
          <button
            type="button"
            className="ml-auto rounded px-2 text-lg leading-none text-muted hover:bg-hover disabled:opacity-40"
            onClick={close}
            disabled={busy}
            aria-label="Fechar"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-3 text-xs">
          <div className="flex flex-wrap items-center gap-1.5" data-testid="mutation-labels">
            <span
              className="badge font-semibold"
              title={preview.capability.reason}
              data-testid="capability-badge"
            >
              {preview.capability.class}
            </span>
            {labels.map((k) => (
              <span
                key={k}
                className="badge border-accent/60 font-semibold text-accent"
                title={k}
                data-testid="preview-label"
              >
                {PREVIEW_KIND_LABEL[k]}
              </span>
            ))}
          </div>

          <pre className="max-h-24 overflow-auto rounded bg-panel2 px-2 py-1 font-mono whitespace-pre-wrap">
            {sql}
          </pre>

          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5" data-testid="mutation-impact">
            <dt className="text-muted">Ambiente</dt>
            <dd className="font-semibold" data-testid="impact-environment">
              {preview.impact.environment}
            </dd>
            <dt className="text-muted">Entidade</dt>
            <dd className="font-mono">{preview.impact.entities.join(', ') || '—'}</dd>
            <dt className="text-muted">Registros</dt>
            <dd data-testid="impact-rows">{preview.impact.rows}</dd>
            <dt className="text-muted">Plano expira em</dt>
            <dd data-testid="plan-countdown" className={expired ? 'font-semibold text-danger' : ''}>
              {report
                ? 'plano utilizado'
                : expired
                  ? 'expirado: gere uma nova prévia'
                  : formatCountdown(remaining)}
            </dd>
          </dl>

          <Diff targets={preview.preview.targets} />

          {!preview.execution.available && report === null && (
            <p className="rounded border border-warn/60 bg-warn/10 px-3 py-2 text-warn" role="note">
              A escrita está indisponível agora
              {preview.execution.safeMode ? ' (SAFE_MODE ativo)' : ''}
              {!preview.execution.globalWriteEnabled ? ' (GLOBAL_WRITE_ENABLED desligado)' : ''}
              {!preview.execution.writeToSankhya ? ' (WRITE_TO_SANKHYA desligado)' : ''}. O servidor
              recusará a execução.
            </p>
          )}

          {preview.requires.approval && report === null && (
            <div
              className="space-y-1 rounded border border-warn/60 px-3 py-2"
              data-testid="approval-required"
            >
              <p className="font-semibold">Esta alteração exige aprovação de outra pessoa.</p>
              {approval === 'requested' ? (
                <p role="status" data-testid="approval-requested">
                  Aprovação solicitada. Execute depois que um aprovador decidir.
                </p>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => void askApproval()}
                  disabled={approval === 'requesting' || expired}
                  data-testid="request-approval"
                >
                  Solicitar aprovação
                </button>
              )}
              {approvalError !== null && <Refusal error={approvalError} />}
            </div>
          )}

          {phrase !== null && report === null && (
            <div className="space-y-1">
              <label htmlFor={confirmId} className="block">
                Para confirmar, digite exatamente:{' '}
                <code className="font-semibold" data-testid="confirmation-phrase">
                  {phrase}
                </code>
              </label>
              <input
                id={confirmId}
                className="input w-full font-mono"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                data-testid="confirmation-input"
              />
            </div>
          )}

          {outcomeUnknown && <UnknownWarning />}
          {error !== null && <Refusal error={error} />}
          {planDead && !outcomeUnknown && (
            <p className="text-muted">Este plano não pode mais ser executado.</p>
          )}
          {report && <Report report={report} />}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            {report ? 'Fechar' : 'Cancelar'}
          </button>
          {report === null && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void execute()}
              disabled={!canExecute}
              aria-busy={busy}
              data-testid="mutation-execute"
            >
              {busy ? 'Executando…' : 'Executar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
