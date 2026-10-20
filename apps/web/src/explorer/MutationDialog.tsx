import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ApiError } from '../api/client';
import { describeError } from '../api/errors';
import { executePlan, requestApproval } from '../api/mutations';
import type {
  ExecutionReport,
  ExecutionStep,
  PreparedPlan,
  PreviewTarget,
  StepOutcome,
  VerificationLabel,
} from '../api/mutations';
import type { Value } from '../api/types';
import {
  REPORT_STATUS_TEXT,
  confirmationMatches,
  formatCountdown,
  isApprovalPending,
  mergeOutcome,
  outcomeOf,
  previewLabelText,
  previewLabelsOf,
  remainingSeconds,
} from './runState';
import type { MutationOutcome } from './runState';

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

/** FORBIDDEN because the approver rejected the plan: it can never run. */
function isApprovalRejected(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.code === 'FORBIDDEN' &&
    err.details?.reason === 'approval_rejected'
  );
}

/** A refusal after which this plan can never run (a new preview is needed). */
function isPlanDead(err: unknown): boolean {
  return (err instanceof ApiError && PLAN_DEAD.has(err.code)) || isApprovalRejected(err);
}

/** The verification the server recorded with a WRITE_OUTCOME_UNKNOWN answer, if any. */
function recordedVerification(err: unknown): VerificationLabel | null {
  if (!(err instanceof ApiError) || err.code !== 'WRITE_OUTCOME_UNKNOWN') return null;
  const v = err.details?.verification;
  return typeof v === 'string' && Object.hasOwn(VERIFICATION_TEXT, v)
    ? (v as VerificationLabel)
    : null;
}

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
            // A DELETE target has a `before` and an empty `after`: the row goes away, which is
            // not the same as its columns becoming NULL.
            const removed = t.before !== null && Object.keys(t.after).length === 0;
            const cols = [...new Set([...Object.keys(t.before ?? {}), ...Object.keys(t.after)])];
            const changed = removed
              ? cols
              : cols.filter((c) => t.before === null || show(t.before[c]) !== show(t.after[c]));
            const rows = changed.length > 0 ? changed : cols.slice(0, 1);
            return rows.map((c, j) => (
              <tr key={`${i}-${c}`} className="border-t border-line align-top">
                <td className="px-2 py-1 font-mono">{j === 0 ? keyText(t.key) || '—' : ''}</td>
                <td className="px-2 py-1 font-mono">{c}</td>
                <td className="px-2 py-1 font-mono text-danger">
                  {t.before === null ? '(novo registro)' : show(t.before[c] as Value)}
                </td>
                <td className="px-2 py-1 font-mono text-ok">
                  {removed ? '(registro removido)' : show(t.after[c] as Value)}
                </td>
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
        <span className="font-semibold">Execução {REPORT_STATUS_TEXT[report.status]}</span>
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

function UnknownWarning({
  canReplay = false,
  verification = null,
}: {
  canReplay?: boolean;
  verification?: VerificationLabel | null;
}) {
  return (
    <div
      role="alert"
      className="rounded border border-danger bg-danger/10 px-3 py-2 font-semibold text-danger"
      data-testid="outcome-unknown"
    >
      NÃO repita esta operação. A alteração pode ter sido gravada, mas o resultado não pôde ser
      confirmado. Confira os registros no Sankhya antes de qualquer nova tentativa.
      {verification && (
        <span className="mt-1 block font-normal" data-testid="outcome-unknown-verification">
          Verificação registrada pelo servidor: <strong>{verification}</strong>.{' '}
          {VERIFICATION_TEXT[verification]}
        </span>
      )}
      {canReplay && (
        <span className="mt-1 block font-normal">
          &quot;Consultar resultado&quot; reenvia o mesmo pedido, com a mesma chave de idempotência:
          se a primeira tentativa foi registrada, o servidor só devolve o resultado; se ela não
          chegou ao servidor, a alteração é executada agora, uma única vez.
        </span>
      )}
    </div>
  );
}

function ApprovalPending({ error }: { error: unknown }) {
  const code = error instanceof ApiError ? error.code : 'FORBIDDEN';
  return (
    <div
      role="status"
      className="rounded border border-warn/60 bg-warn/10 px-3 py-2 text-warn"
      data-testid="approval-pending"
    >
      <div className="font-semibold">
        Aguardando aprovação <span className="font-mono text-xs opacity-80">[{code}]</span>
      </div>
      <div className="mt-0.5 text-xs text-fg/80">
        Nada foi gravado. Execute de novo depois que um aprovador aprovar este plano.
      </div>
    </div>
  );
}

/**
 * A refusal, with the capability label and request id the server sent. After an unknown outcome
 * the generic title (which may say "gere uma nova prévia") is replaced: the do-not-repeat warning
 * next to it is what the user must follow.
 */
function Refusal({ error, afterUnknown = false }: { error: unknown; afterUnknown?: boolean }) {
  const e = describeError(error);
  const capability = error instanceof ApiError ? error.details?.capability : undefined;
  return (
    <div
      role="alert"
      className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
      data-testid="mutation-error"
    >
      <div className="font-semibold">
        {typeof capability === 'string' && capability !== '' && (
          <span className="badge mr-1.5 font-semibold" data-testid="refusal-capability">
            {capability}
          </span>
        )}
        {afterUnknown ? 'O servidor recusou o reenvio.' : e.title}{' '}
        <span className="font-mono text-xs opacity-80">[{e.code}]</span>
      </div>
      {e.detail && <div className="mt-0.5 text-xs text-fg/80">{e.detail}</div>}
      {e.requestId && (
        <div className="mt-0.5 text-[11px] text-muted">request id: {e.requestId}</div>
      )}
    </div>
  );
}

/** The write switches that block this plan; SCRATCH skips the Sankhya write switches. */
function blockingSwitches(plan: PreparedPlan): string[] {
  const x = plan.execution;
  if (!x) return [];
  const scratch = plan.capability.route === 'SCRATCH';
  const out: string[] = [];
  if (!scratch && x.safeMode && plan.impact.environment === 'PRODUCTION') {
    out.push('SAFE_MODE ativo');
  }
  if (!x.globalWriteEnabled) out.push('GLOBAL_WRITE_ENABLED desligado');
  if (!scratch && !x.writeToSankhya) out.push('WRITE_TO_SANKHYA desligado');
  return out;
}

interface Props {
  /** The plan: a /api/query/preview answer, or a plan the server prepared elsewhere. */
  preview: PreparedPlan;
  sql: string;
  onClose: () => void;
  /**
   * Called after every execute that reached the network: with the report, or with an error
   * whose outcome may be unknown (so the page can keep warning after the dialog closes).
   */
  onOutcome?: (outcome: MutationOutcome) => void;
  /** The plan's idempotency key, when the caller keeps it (a reopened plan reuses its key). */
  idempotencyKey?: string;
  /** Idempotency key factory, used only without `idempotencyKey`; one key per plan. */
  newKey?: () => string;
  /** What earlier executes of this plan produced (a reopened plan). */
  initialOutcome?: MutationOutcome;
  /** The approval of this plan was already requested (a reopened plan). */
  approvalRequested?: boolean;
  onApprovalRequested?: () => void;
  /** The plan reached a final outcome: a report, or a refusal after which it can never run. */
  onSettled?: () => void;
}

/**
 * Preview, confirmation and execution of one mutation plan. Opening it never writes: only the
 * explicit "Executar" click calls /api/query/execute. The plan token stays in memory (here and in
 * the caller's pending-plan store) and is never stored or logged.
 */
export function MutationDialog({
  preview,
  sql,
  onClose,
  onOutcome,
  idempotencyKey: givenKey,
  newKey,
  initialOutcome,
  approvalRequested = false,
  onApprovalRequested,
  onSettled,
}: Props) {
  const titleId = useId();
  const confirmId = useId();
  const ref = useRef<HTMLDivElement>(null);
  // One key per plan: a double click or a retry after a lost answer never executes twice.
  const [idempotencyKey] = useState(() => givenKey ?? (newKey ?? (() => crypto.randomUUID()))());
  const inFlight = useRef(false);
  const approvalInFlight = useRef(false);
  // Everything known about this plan's executes so far (sticky once unknown).
  const outcomeSoFar = useRef<MutationOutcome | undefined>(initialOutcome);
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState<ExecutionReport | null>(null);
  const [approval, setApproval] = useState<'none' | 'requesting' | 'requested'>(
    approvalRequested ? 'requested' : 'none',
  );
  const [approvalError, setApprovalError] = useState<unknown>(null);
  const [now, setNow] = useState(() => Date.now());
  // Sticky once an answer left the outcome unknown; only a replayed report clears it.
  const [unknownSeen, setUnknownSeen] = useState(initialOutcome?.unknown === true);

  const remaining = remainingSeconds(preview.expiresAt, now);
  const expired = remaining <= 0;
  const phrase = preview.requires.strongConfirmation;
  const matches = confirmationMatches(typed, phrase);
  const outcomeUnknown = unknownSeen;
  const approvalPending = isApprovalPending(error);
  const planDead = isPlanDead(error);
  // After an unknown outcome the same-key resend stays possible past the countdown: the server
  // replays a recorded result before checking the expiry.
  const canExecute =
    !busy && (!expired || outcomeUnknown) && matches && report === null && !planDead;

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
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement as HTMLElement | null;
    // Focus on the container itself (or anything not tabbable) wraps too, so Tab never leaves.
    const outside = !active || !items.includes(active);
    if (e.shiftKey && (outside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (outside || active === last)) {
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
      record(outcomeOf({ report: res }));
      onSettled?.();
    } catch (err) {
      setError(err);
      record(outcomeOf({ error: err }));
      if (isPlanDead(err)) onSettled?.();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function record(next: MutationOutcome) {
    const outcome = mergeOutcome(outcomeSoFar.current, next);
    outcomeSoFar.current = outcome;
    setUnknownSeen(outcome.unknown);
    onOutcome?.(outcome);
  }

  async function askApproval() {
    if (approvalInFlight.current || approval !== 'none') return;
    approvalInFlight.current = true;
    setApproval('requesting');
    setApprovalError(null);
    try {
      await requestApproval(preview.planId);
      setApproval('requested');
      onApprovalRequested?.();
    } catch (err) {
      setApprovalError(err);
      setApproval('none');
    } finally {
      approvalInFlight.current = false;
    }
  }

  const labels = previewLabelsOf(preview);
  const blocked = blockingSwitches(preview);

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
                {previewLabelText(k)}
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
                  ? outcomeUnknown
                    ? 'expirado (o reenvio com a mesma chave continua possível)'
                    : 'expirado: gere uma nova prévia'
                  : formatCountdown(remaining)}
            </dd>
          </dl>

          <Diff targets={preview.preview.targets} />

          {preview.execution?.available === false && report === null && (
            <p className="rounded border border-warn/60 bg-warn/10 px-3 py-2 text-warn" role="note">
              A escrita está indisponível agora
              {blocked.map((b) => ` (${b})`).join('')}. O servidor recusará a execução.
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

          {outcomeUnknown && report === null && (
            <UnknownWarning canReplay={!planDead} verification={recordedVerification(error)} />
          )}
          {error !== null &&
            (approvalPending ? (
              <ApprovalPending error={error} />
            ) : (
              <Refusal error={error} afterUnknown={outcomeUnknown} />
            ))}
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
              {busy ? 'Executando…' : outcomeUnknown ? 'Consultar resultado' : 'Executar'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
