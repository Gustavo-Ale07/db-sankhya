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
  | { status: 'mutation'; sql: string; planId: string; report?: ExecutionReport };

/** pt-BR text of each exact preview label of the API. */
export const PREVIEW_KIND_LABEL: Record<PreviewKind, string> = {
  SIMULATED_PREVIEW: 'PRÉVIA SIMULADA',
  IMPACT_ANALYSIS: 'ANÁLISE DE IMPACTO',
  TRANSACTIONAL_DRY_RUN: 'DRY RUN TRANSACIONAL',
};

const isKnownKind = (k: unknown): k is PreviewKind =>
  typeof k === 'string' && Object.hasOwn(PREVIEW_KIND_LABEL, k);

/** The primary label first, then every other applicable one; unknown labels are dropped. */
export function previewLabelsOf(
  p: Pick<MutationPreview, 'previewKind' | 'previewLabels'>,
): PreviewKind[] {
  const out: PreviewKind[] = [];
  for (const k of [p.previewKind, ...(p.previewLabels ?? [])]) {
    if (isKnownKind(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

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
