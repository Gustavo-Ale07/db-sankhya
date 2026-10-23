import { ApiError } from '../api/client';
import type { ExecutionReport, MutationPreview, PreviewKind } from '../api/mutations';
import type { QueryResult } from '../api/types';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; executionId: string; startedAt: number }
  | { status: 'result'; sql: string; result: QueryResult }
  | { status: 'error'; sql: string; error: unknown }
  /** The server answered "mutation": its preview is being prepared. Nothing is written. */
  | { status: 'previewing'; sql: string }
  /**
   * A mutation plan is in the dialog (or was closed). Only the plan id is kept here: the token
   * stays in the dialog state, in memory only.
   */
  | { status: 'mutation'; sql: string; planId: string; outcome?: MutationOutcome };

/**
 * What the last execute of a plan produced, without the token. `unknown` is true whenever the
 * write may have happened but no confirmed final report says so: the user must check the records
 * and never repeat the change.
 */
export interface MutationOutcome {
  /** An execute request was sent for this plan. */
  sent: true;
  unknown: boolean;
  report?: ExecutionReport;
  errorCode?: string;
}

/**
 * Answers that do not prove whether the write happened: the audit failed after a save
 * (WRITE_OUTCOME_UNKNOWN), the answer was lost (network, 5xx/gateway) or the plan is still being
 * executed elsewhere (CONFLICT). Definite refusals (READ_ONLY_MODE, FORBIDDEN, TARGETS_CHANGED,
 * CONFIRMATION_*...) are raised before any save, so they are known outcomes.
 */
export function outcomeOf(
  result: { report: ExecutionReport } | { error: unknown },
): MutationOutcome {
  if ('report' in result) {
    return {
      sent: true,
      unknown: result.report.steps.some((s) => s.outcome === 'unknown'),
      report: result.report,
    };
  }
  const err = result.error;
  if (!(err instanceof ApiError)) return { sent: true, unknown: true, errorCode: 'UNKNOWN' };
  const unknown =
    err.code === 'WRITE_OUTCOME_UNKNOWN' ||
    err.code === 'NETWORK_ERROR' ||
    err.code === 'CONFLICT' ||
    err.status === 0 ||
    err.status >= 500;
  return { sent: true, unknown, errorCode: err.code };
}

/**
 * Folds the answer of a new execute of the same plan into what is already known. Once an outcome
 * was unknown it stays unknown (keeping its first error code): a later refusal, rate limit or
 * expiry says nothing about the earlier attempt. Only a report clears it, because the server
 * replays the recorded result of that plan for the same key: a definite answer.
 */
export function mergeOutcome(
  prev: MutationOutcome | undefined,
  next: MutationOutcome,
): MutationOutcome {
  if (!prev?.unknown || next.report) return next;
  return { sent: true, unknown: true, ...(prev.errorCode ? { errorCode: prev.errorCode } : {}) };
}

/** FORBIDDEN because the plan still waits for its four-eyes approval (nothing was consumed). */
export function isApprovalPending(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.code === 'FORBIDDEN' &&
    err.details?.reason === 'approval_pending'
  );
}

/** pt-BR text of each exact preview label of the API. */
export const PREVIEW_KIND_LABEL: Record<PreviewKind, string> = {
  SIMULATED_PREVIEW: 'PRÉVIA SIMULADA',
  IMPACT_ANALYSIS: 'ANÁLISE DE IMPACTO',
  TRANSACTIONAL_DRY_RUN: 'DRY RUN TRANSACIONAL',
  // Applied directly and then verified: there is no simulation to show. The label stays neutral
  // (it never names the server-side route).
  SERVER_EXECUTION: 'EXECUÇÃO DIRETA',
};

const isKnownKind = (k: unknown): k is PreviewKind =>
  typeof k === 'string' && Object.hasOwn(PREVIEW_KIND_LABEL, k);

/**
 * The primary label first, then every other applicable one, without duplicates. A label this
 * client does not know is kept as its raw code (shown verbatim, never invented or hidden).
 */
export function previewLabelsOf(
  p: Pick<MutationPreview, 'previewKind' | 'previewLabels'>,
): string[] {
  const out: string[] = [];
  for (const k of [p.previewKind, ...(p.previewLabels ?? [])]) {
    if (typeof k === 'string' && k && !out.includes(k)) out.push(k);
  }
  return out;
}

/** The pt-BR text of a label, or the raw code when it is not a known one. */
export function previewLabelText(k: string): string {
  return isKnownKind(k) ? PREVIEW_KIND_LABEL[k] : k;
}

/** pt-BR text of the report status. */
export const REPORT_STATUS_TEXT: Record<ExecutionReport['status'], string> = {
  success: 'concluída',
  partial: 'parcial',
  failed: 'falhou',
};

/** The typed confirmation must equal the phrase exactly (case, spaces and all). */
export function confirmationMatches(typed: string, phrase: string | null): boolean {
  return phrase === null || typed === phrase;
}

/** Whole seconds until `expiresAt` (rounded up), never negative; unreadable means expired. */
export function remainingSeconds(expiresAt: string, now: number): number {
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return 0;
  return Math.max(0, Math.ceil((end - now) / 1000));
}

export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The client never classifies SQL. /api/query answers a statement it classified as a
 * previewable mutation with SQL_UNSUPPORTED and `details.preview`; only that answer opens the
 * preview flow.
 */
export function isPreviewPointer(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.code === 'SQL_UNSUPPORTED' &&
    err.details?.preview === '/api/query/preview'
  );
}
