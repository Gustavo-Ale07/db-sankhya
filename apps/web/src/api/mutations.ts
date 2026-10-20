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

/** Answer of POST /api/query/preview. The plan token lives only in memory, never persisted. */
export interface MutationPreview {
  type: 'preview';
  planId: string;
  token: string;
  expiresAt: string;
  capability: { class: string; route: string; reason: string };
  previewKind: PreviewKind;
  previewLabels: PreviewKind[];
  preview: { targets: PreviewTarget[]; affected: number };
  impact: { entities: string[]; rows: number; environment: string };
  requires: { strongConfirmation: string | null; approval: boolean };
  execution: {
    available: boolean;
    safeMode: boolean;
    globalWriteEnabled: boolean;
    writeToSankhya: boolean;
  };
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

export const previewMutation = (sql: string, connectionId: string) =>
  api.post<MutationPreview>('/api/query/preview', { sql, connectionId });

export const executePlan = (input: ExecuteInput) =>
  api.post<ExecutionReport>('/api/query/execute', input);

export const requestApproval = (planId: string) =>
  api.post<{ approval: { id: string; expiresAt: string } }>('/api/approvals', { planId });
