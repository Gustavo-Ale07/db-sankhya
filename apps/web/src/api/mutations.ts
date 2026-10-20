import { api } from './client';
import type { Value } from './types';

/** Exact preview labels of the API (honest labels: never combined into one string). */
export type PreviewKind = 'SIMULATED_PREVIEW' | 'IMPACT_ANALYSIS' | 'TRANSACTIONAL_DRY_RUN';
export type VerificationLabel = 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'UNVERIFIED' | 'FAILED';
export type StepOutcome = 'ok' | 'error' | 'not_attempted' | 'unknown';

export type RecordValues = Record<string, Value>;

export interface PreviewTarget {
  key: RecordValues;
  /** null for an INSERT: there is no row yet. */
  before: RecordValues | null;
  after: RecordValues;
}

/** Whether execute would pass the write switches when the preview was made. */
export interface ExecutionSwitches {
  available: boolean;
  /** The caller holds the permission to execute this plan (a DATA.PREVIEW-only caller does not). */
  permitted?: boolean;
  safeMode: boolean;
  globalWriteEnabled: boolean;
  writeToSankhya: boolean;
}

/**
 * A plan the server prepared, with its token. /api/query/preview answers it as a
 * `MutationPreview`; POST /api/audit/:id/rollback-plan hands it out as `plan`, without `type` and
 * without the write-switch summary. The token lives only in memory, never persisted.
 */
export interface PreparedPlan {
  planId: string;
  token: string;
  expiresAt: string;
  /** Statement kind, computed by the server (SQL plans only; absent on business actions). */
  operation?: 'INSERT' | 'UPDATE' | 'DELETE';
  capability: { class: string; route: string; reason: string };
  previewKind: PreviewKind;
  previewLabels: PreviewKind[];
  preview: { targets: PreviewTarget[]; affected: number };
  impact: { entities: string[]; rows: number; environment: string };
  requires: { strongConfirmation: string | null; approval: boolean };
  execution?: ExecutionSwitches;
}

/** Answer of POST /api/query/preview. The plan token lives only in memory, never persisted. */
export interface MutationPreview extends PreparedPlan {
  type: 'preview';
  execution: ExecutionSwitches;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a server answer can be opened as a plan: an id, a token, an expiry and the parts the
 * dialog renders. Anything else is refused rather than half-shown.
 */
export function isPreparedPlan(v: unknown): v is PreparedPlan {
  if (!isRecord(v)) return false;
  return (
    typeof v.planId === 'string' &&
    v.planId !== '' &&
    typeof v.token === 'string' &&
    v.token !== '' &&
    typeof v.expiresAt === 'string' &&
    isRecord(v.capability) &&
    isRecord(v.preview) &&
    Array.isArray(v.preview.targets) &&
    isRecord(v.impact) &&
    Array.isArray(v.impact.entities) &&
    isRecord(v.requires)
  );
}

export interface ExecutionStep {
  key: Record<string, unknown>;
  outcome: StepOutcome;
  errorCode?: string;
  verified?: boolean;
}

/** Answer of POST /api/query/execute. */
export interface ExecutionReport {
  type: 'execution';
  planId: string;
  status: 'success' | 'partial' | 'failed';
  verification: VerificationLabel;
  steps: ExecutionStep[];
}

export interface ExecuteInput {
  planId: string;
  token: string;
  idempotencyKey: string;
  strongConfirmation?: string;
}

export const previewMutation = (sql: string, connectionId: string, signal?: AbortSignal) =>
  api.post<MutationPreview>('/api/query/preview', { sql, connectionId }, signal ? { signal } : {});

export const executePlan = (input: ExecuteInput) =>
  api.post<ExecutionReport>('/api/query/execute', input);

export const requestApproval = (planId: string) =>
  api.post<{ approval: { id: string; expiresAt: string } }>('/api/approvals', { planId });
