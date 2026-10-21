import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
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
import {
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
  VERIFIED: 'Os valores foram lidos novamente no Sankhya e conferem.',
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

/** How many record cards (or report steps) one page shows: never thousands in the DOM. */
const PAGE_SIZE = 20;
/** Above this many targets only the first card starts expanded. */
const EXPAND_ALL_UP_TO = 5;

type Operation = 'INSERT' | 'UPDATE' | 'DELETE';

function show(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function keyText(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([k, v]) => `${k} = ${show(v)}`)
    .join(', ');
}

/** A DELETE target has a `before` and an empty `after`: the row goes away. */
function isRemoval(t: PreviewTarget): boolean {
  return t.before !== null && (t.after === null || Object.keys(t.after ?? {}).length === 0);
}

/**
 * Whether this target's row goes away: the server's operation decides; only a plan without one
 * (older plans, business actions) falls back to the shape of the target.
 */
function removesRow(t: PreviewTarget, operation: Operation | null): boolean {
  return operation === 'DELETE' || (operation === null && isRemoval(t));
}

/**
 * The statement kind: the server's, or for an older plan derived from its targets. Null when
 * nothing tells (a business action without targets): the capability label stands in for it.
 */
function operationOf(plan: PreparedPlan): Operation | null {
  if (plan.operation) return plan.operation;
  const targets = plan.preview.targets;
  if (targets.some((t) => t.before === null)) return 'INSERT';
  if (targets.some(isRemoval)) return 'DELETE';
  return targets.length > 0 ? 'UPDATE' : null;
}

/** The count sentence, from the server's numbers. */
function countSentence(op: Operation | null, n: number): string {
  const one = n === 1;
  switch (op) {
    case 'INSERT':
      return one ? '1 novo registro será criado' : `${n} novos registros serão criados`;
    case 'DELETE':
      return one ? '1 registro será removido' : `${n} registros serão removidos`;
    case 'UPDATE':
      return one ? '1 registro será alterado' : `${n} registros serão alterados`;
    default:
      return one ? '1 registro afetado' : `${n} registros afetados`;
  }
}

function Pager({
  page,
  pages,
  onChange,
  testId,
}: {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  testId: string;
}) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onChange(page - 1)}
        disabled={page <= 0}
      >
        Anterior
      </button>
      <span data-testid={testId}>
        Página {page + 1} de {pages}
      </span>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onChange(page + 1)}
        disabled={page >= pages - 1}
      >
        Próxima
      </button>
    </div>
  );
}

function Cell({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-muted italic">NULL</span>;
  return <>{show(v)}</>;
}

/** Field rows of one side (an INSERT's new row, a DELETE's existing row). */
function FieldList({ row, side }: { row: Record<string, unknown>; side: 'before' | 'after' }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
      {Object.keys(row).map((c) => (
        <div key={c} className="contents" data-testid="diff-field" data-field={c}>
          <dt className="text-muted">{c}</dt>
          <dd className="break-all" data-testid={`diff-${side}`}>
            <Cell v={row[c]} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SideHeading({ children }: { children: string }) {
  return <div className="mb-1 text-[10px] font-semibold tracking-wide text-muted">{children}</div>;
}

function RecordCard({
  target,
  index,
  expanded,
  onToggle,
  showAll,
  removed,
}: {
  target: PreviewTarget;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  showAll: boolean;
  removed: boolean;
}) {
  const bodyId = useId();
  const inserted = !removed && target.before === null;
  const key = keyText(target.key);
  let body: ReactNode;
  if (inserted) {
    body = (
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <SideHeading>ANTES</SideHeading>
          <p className="text-muted italic">(novo registro)</p>
        </div>
        <div>
          <SideHeading>DEPOIS</SideHeading>
          <FieldList row={target.after} side="after" />
        </div>
      </div>
    );
  } else if (removed) {
    body = (
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <SideHeading>ANTES</SideHeading>
          <FieldList row={target.before ?? {}} side="before" />
        </div>
        <div>
          <SideHeading>DEPOIS</SideHeading>
          <p className="rounded border border-danger bg-danger/10 px-2 py-3 text-center font-semibold text-danger">
            REGISTRO SERÁ REMOVIDO
          </p>
        </div>
      </div>
    );
  } else {
    const before = target.before ?? {};
    const after = target.after;
    const cols = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const changed = cols.filter(
      (c) => Object.hasOwn(after, c) && show(before[c]) !== show(after[c]),
    );
    const list = showAll ? cols : changed;
    body =
      list.length === 0 ? (
        <p className="text-muted">Nenhum campo muda de valor.</p>
      ) : (
        <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 font-mono">
          <span />
          <SideHeading>ANTES</SideHeading>
          <SideHeading>DEPOIS</SideHeading>
          {list.map((c) => {
            const now = Object.hasOwn(after, c) ? after[c] : before[c];
            const differs = changed.includes(c);
            return (
              <div key={c} className="contents" data-testid="diff-field" data-field={c}>
                <span className="text-muted">{c}</span>
                <span
                  className={`break-all ${differs ? 'text-danger' : ''}`}
                  data-testid="diff-before"
                >
                  <Cell v={before[c]} />
                </span>
                <span
                  className={`break-all ${differs ? 'font-semibold text-ok' : ''}`}
                  data-testid="diff-after"
                >
                  {differs && <span className="mr-1 text-muted">→</span>}
                  <Cell v={now} />
                </span>
              </div>
            );
          })}
        </div>
      );
  }
  return (
    <div
      className={`rounded border ${removed ? 'border-danger/60' : 'border-line'}`}
      data-testid="diff-card"
    >
      <button
        type="button"
        className={`flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-hover ${
          removed ? 'text-danger' : ''
        }`}
        aria-expanded={expanded}
        aria-controls={expanded ? bodyId : undefined}
        onClick={onToggle}
        data-testid="diff-card-toggle"
      >
        <span aria-hidden="true" className="w-3 text-muted">
          {expanded ? '▾' : '▸'}
        </span>
        <span className="font-mono font-semibold">
          {key ? `Registro ${key}` : `Registro ${index + 1}`}
        </span>
        {removed && <span className="badge ml-auto border-danger/60 text-danger">remoção</span>}
        {inserted && <span className="badge ml-auto border-ok/60 text-ok">novo</span>}
      </button>
      {expanded && (
        <div id={bodyId} className="border-t border-line px-3 py-2">
          {body}
        </div>
      )}
    </div>
  );
}

/** The record cards of the preview, 20 per page; only the current page is in the DOM. */
function Diff({
  targets,
  affected,
  operation,
}: {
  targets: PreviewTarget[];
  affected: number;
  /** The server's statement kind; null for a plan that does not carry one. */
  operation: Operation | null;
}) {
  const [page, setPage] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // Cards whose state differs from the default (expanded when few targets, else only the first).
  const [flipped, setFlipped] = useState<ReadonlySet<number>>(() => new Set());
  if (targets.length === 0) return <p className="text-muted">Nenhum registro afetado.</p>;
  const pages = Math.ceil(targets.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const shown = targets.slice(start, start + PAGE_SIZE);
  const hasUpdate = targets.some((t) => t.before !== null && !removesRow(t, operation));
  const expandedByDefault = (i: number) => targets.length <= EXPAND_ALL_UP_TO || i === 0;
  const toggle = (i: number) =>
    setFlipped((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <div className="space-y-2" data-testid="mutation-diff">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted" data-testid="diff-total">
          {targets.length === 1 ? '1 registro no total' : `${targets.length} registros no total`}
          {affected > targets.length && ` (a prévia lista ${targets.length} de ${affected})`}
        </span>
        {hasUpdate && (
          <button
            type="button"
            className="btn btn-sm"
            aria-pressed={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? 'Mostrar só os campos alterados' : 'Mostrar todos os campos'}
          </button>
        )}
        <div className="ml-auto">
          <Pager page={page} pages={pages} onChange={setPage} testId="diff-page" />
        </div>
      </div>
      {shown.map((t, j) => {
        const i = start + j;
        return (
          <RecordCard
            key={i}
            target={t}
            index={i}
            expanded={expandedByDefault(i) !== flipped.has(i)}
            onToggle={() => toggle(i)}
            showAll={showAll}
            removed={removesRow(t, operation)}
          />
        );
      })}
    </div>
  );
}

/** Title and tone of a report: "concluída" only for a success that was read back and matches. */
function reportTitle(report: ExecutionReport): { text: string; tone: string } {
  if (report.steps.some((s) => s.outcome === 'unknown')) {
    return { text: 'Resultado desconhecido', tone: 'text-danger' };
  }
  if (report.verification === 'FAILED') {
    return { text: 'Alteração com divergência', tone: 'text-danger' };
  }
  if (report.status === 'failed') return { text: 'A alteração falhou', tone: 'text-danger' };
  if (report.status === 'partial') return { text: 'Alteração parcial', tone: 'text-warn' };
  switch (report.verification) {
    case 'VERIFIED':
      return { text: 'Alteração concluída', tone: 'text-ok' };
    case 'PARTIALLY_VERIFIED':
      return { text: 'Alteração executada — verificação parcial', tone: 'text-warn' };
    default:
      return { text: 'Não foi possível verificar', tone: 'text-warn' };
  }
}

const hasValues = (s: ExecutionStep) =>
  s.before !== undefined || s.expected !== undefined || s.observed !== undefined;

const NOT_REREAD = 'não foi possível reler';

/**
 * One step's values. AGORA is only what the server read back (`observed`); the plan's intent
 * (`expected`) is shown only next to it, as ESPERADO, when the read-back did not match.
 */
function StepValues({
  step,
  mismatch,
  removal,
}: {
  step: ExecutionStep;
  mismatch: boolean;
  /** A DELETE step that went through: there is nothing left to read back. */
  removal: boolean;
}) {
  const observed = step.observed;
  const fields = [
    ...new Set([
      ...Object.keys(step.expected ?? {}),
      ...Object.keys(observed ?? {}),
      ...Object.keys(step.before ?? {}),
    ]),
  ];
  if (fields.length === 0) return null;
  if (mismatch) {
    return (
      <div
        className="rounded border border-danger/60 bg-danger/10 px-2 py-1 text-danger"
        data-testid="step-mismatch"
      >
        <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 font-mono">
          <span />
          <span className="text-[10px] font-semibold">ESPERADO</span>
          <span className="text-[10px] font-semibold">OBSERVADO</span>
          {fields.map((c) => (
            <div key={c} className="contents">
              <span>{c}</span>
              <span className="break-all">
                {step.expected && Object.hasOwn(step.expected, c) ? show(step.expected[c]) : '—'}
              </span>
              <span className="break-all font-semibold">
                {observed ? (Object.hasOwn(observed, c) ? show(observed[c]) : '—') : NOT_REREAD}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-0.5 font-mono">
      <span />
      <SideHeading>ANTES</SideHeading>
      <SideHeading>AGORA</SideHeading>
      {fields.map((c) => (
        <div key={c} className="contents">
          <span className="text-muted">{c}</span>
          <span className="break-all">
            {step.before === null ? (
              <span className="text-muted italic">(novo registro)</span>
            ) : step.before && Object.hasOwn(step.before, c) ? (
              <Cell v={step.before[c]} />
            ) : (
              '—'
            )}
          </span>
          <span className="break-all" data-testid="step-now">
            {observed ? (
              Object.hasOwn(observed, c) ? (
                <Cell v={observed[c]} />
              ) : (
                '—'
              )
            ) : removal ? (
              <span className="font-semibold text-danger">registro removido</span>
            ) : (
              <span className="text-warn italic">{NOT_REREAD}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function Report({ report, operation }: { report: ExecutionReport; operation: Operation | null }) {
  const [page, setPage] = useState(0);
  const unknown = report.steps.some((s) => s.outcome === 'unknown');
  const title = reportTitle(report);
  const pages = Math.ceil(report.steps.length / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const noValues =
    report.valuesTruncated === true || (report.steps.length > 0 && !report.steps.some(hasValues));
  return (
    <div className="space-y-2" data-testid="execution-report">
      <h3 className={`text-sm font-semibold ${title.tone}`} data-testid="report-title">
        {title.text}
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`badge font-semibold ${VERIFICATION_TONE[report.verification]}`}
          data-testid="verification-status"
        >
          {report.verification}
        </span>
        <span className="text-muted">{VERIFICATION_TEXT[report.verification]}</span>
      </div>
      {unknown && <UnknownWarning />}
      {noValues && (
        <p className="text-muted" data-testid="values-unavailable">
          {report.valuesTruncated
            ? 'Alguns valores foram omitidos ou encurtados pelos limites do registro de auditoria.'
            : 'Os valores dos campos não estão disponíveis neste resultado.'}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-muted">
          {report.steps.length === 1 ? '1 registro' : `${report.steps.length} registros`}
        </span>
        <div className="ml-auto">
          <Pager page={page} pages={pages} onChange={setPage} testId="steps-page" />
        </div>
      </div>
      <div className="space-y-2" data-testid="execution-steps">
        {report.steps.slice(start, start + PAGE_SIZE).map((s, j) => {
          const mismatch =
            s.verified === false || (report.verification === 'FAILED' && s.verified !== true);
          const key = keyText(s.key);
          return (
            <div
              key={start + j}
              className={`space-y-1 rounded border px-3 py-2 ${
                mismatch ? 'border-danger/60' : 'border-line'
              }`}
              data-testid="execution-step"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted">{start + j + 1}.</span>
                <span className="font-mono font-semibold">
                  {key ? `Registro ${key}` : `Registro ${start + j + 1}`}
                </span>
                <span>
                  {OUTCOME_TEXT[s.outcome] ?? s.outcome}
                  {s.errorCode && (
                    <span className="ml-1 font-mono text-danger">[{s.errorCode}]</span>
                  )}
                </span>
                <span className={`ml-auto ${s.verified === false ? 'text-danger' : 'text-muted'}`}>
                  Conferido:{' '}
                  {s.verified === true ? 'sim' : s.verified === false ? 'não confere' : '—'}
                </span>
              </div>
              {hasValues(s) && (
                <StepValues
                  step={s}
                  mismatch={mismatch}
                  removal={operation === 'DELETE' && s.outcome === 'ok'}
                />
              )}
            </div>
          );
        })}
      </div>
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
      className="rounded border border-danger bg-danger/10 px-3 py-2 text-danger"
      data-testid="outcome-unknown"
    >
      <div className="font-bold tracking-wide">RESULTADO DESCONHECIDO</div>
      <div className="font-semibold">
        A alteração pode ter sido executada. Não repita a operação antes de conferir o registro.
      </div>
      {verification && (
        <span className="mt-1 block" data-testid="outcome-unknown-verification">
          Verificação registrada pelo servidor: <strong>{verification}</strong>.{' '}
          {VERIFICATION_TEXT[verification]}
        </span>
      )}
      {canReplay && (
        <span className="mt-1 block text-fg/80">
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
 * explicit "Confirmar alteração" click (never an Enter) calls /api/query/execute. The plan token stays in memory (here and in
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
  const executeRef = useRef<HTMLButtonElement>(null);
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
  // A preview-only caller (no permission to execute) and closed write switches keep the button
  // disabled; once an outcome is unknown only the same-key resend remains, whatever they say.
  const permitted = preview.execution?.permitted !== false;
  const available = preview.execution?.available !== false;
  const canExecute =
    !busy &&
    (!expired || outcomeUnknown) &&
    (permitted || outcomeUnknown) &&
    (available || outcomeUnknown) &&
    matches &&
    report === null &&
    !planDead;

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
    // Enter never executes: not in the confirmation input, not on the dialog, not on the button
    // itself (only an explicit click, or Space on the focused button, does).
    if (e.key === 'Enter') {
      const t = e.target as HTMLElement;
      if (t === executeRef.current || t === ref.current || t.tagName === 'INPUT') {
        e.preventDefault();
      }
      return;
    }
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
  const operation = operationOf(preview);
  const environment = preview.impact.environment;
  const production = environment === 'PRODUCTION';
  const entities = preview.impact.entities.join(', ') || '—';
  const rows =
    typeof preview.impact.rows === 'number' ? preview.impact.rows : preview.preview.affected;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="flex max-h-[85vh] w-[95vw] max-w-4xl flex-col rounded-lg border border-line bg-panel text-fg shadow-xl"
        data-testid="mutation-dialog"
      >
        <div className="space-y-1 border-b border-line px-4 py-2">
          <div className="flex items-center">
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
          <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="mutation-impact">
            <span
              className={`font-mono font-semibold ${operation === 'DELETE' ? 'text-danger' : ''}`}
              data-testid="mutation-operation"
            >
              {`${operation ?? preview.capability.class} • ${entities}`}
            </span>
            <span
              className={`badge font-semibold ${
                production ? 'border-danger/60 text-danger' : 'text-muted'
              }`}
              title="Ambiente"
              data-testid="impact-environment"
            >
              {environment}
            </span>
            <span className="ml-auto text-muted">
              {report || expired ? 'Plano' : 'Plano expira em'}{' '}
              <span
                data-testid="plan-countdown"
                className={expired ? 'font-semibold text-danger' : 'text-fg'}
              >
                {report
                  ? 'utilizado'
                  : expired
                    ? outcomeUnknown
                      ? 'expirado (o reenvio com a mesma chave continua possível)'
                      : 'expirado: execute novamente para gerar uma nova prévia'
                    : formatCountdown(remaining)}
              </span>
            </span>
          </div>
        </div>

        {production && (
          <div
            role="alert"
            className="border-y-2 border-danger bg-danger/15 px-4 py-2 text-xs font-bold text-danger"
            data-testid="production-band"
          >
            PRODUÇÃO — Você está prestes a alterar dados do ambiente de produção.
          </div>
        )}

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

          {report === null && (
            <>
              <p
                className={`text-sm font-semibold ${operation === 'DELETE' ? 'text-danger' : ''}`}
                data-testid="impact-rows"
              >
                {countSentence(operation, rows)}
              </p>
              <Diff
                targets={preview.preview.targets}
                affected={preview.preview.affected}
                operation={preview.operation ?? null}
              />
            </>
          )}

          {!permitted && report === null && (
            <p
              className="rounded border border-warn/60 bg-warn/10 px-3 py-2 text-warn"
              data-testid="preview-only-note"
            >
              Você pode ver a prévia, mas não tem permissão para executar esta alteração.
            </p>
          )}

          {!available && report === null && (
            <p className="rounded border border-warn/60 bg-warn/10 px-3 py-2 text-warn" role="note">
              A escrita está indisponível agora
              {blocked.map((b) => ` (${b})`).join('')}. O servidor recusará a execução.
            </p>
          )}

          {preview.requires.approval && permitted && report === null && (
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
          {report && <Report report={report} operation={operation} />}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-2">
          <button type="button" className="btn" onClick={close} disabled={busy}>
            {report ? 'Fechar' : 'Cancelar'}
          </button>
          {report === null && (
            <button
              ref={executeRef}
              type="button"
              className={`btn ${production || operation === 'DELETE' ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => void execute()}
              disabled={!canExecute}
              aria-busy={busy}
              data-testid="mutation-execute"
            >
              {busy
                ? 'Executando…'
                : outcomeUnknown
                  ? 'Consultar resultado'
                  : 'Confirmar alteração'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
