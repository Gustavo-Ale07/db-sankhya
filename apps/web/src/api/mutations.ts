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

/** A scratch table as the server read it: its columns in order and its row count. */
export interface TableStructure {
  name: string;
  rows: number;
  columns: { name: string; type: string }[];
}

/** Scratch DDL dry run: the table before (null: it does not exist yet) and after (null: dropped). */
export interface StructurePreview {
  table: string;
  before: TableStructure | null;
  after: TableStructure | null;
}

/** One Sankhya part a CREATE TABLE tmp_… AS read for its preview (a read only). */
export interface SankhyaPart {
  tables: string[];
  rows: number;
  truncated: boolean;
}

export type PlanOperation =
  'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE';

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
  operation?: PlanOperation;
  capability: { class: string; route: string; reason: string };
  previewKind: PreviewKind;
  previewLabels: PreviewKind[];
  preview: {
    targets: PreviewTarget[];
    affected: number;
    /** Scratch DDL (tmp_*): the structure BEFORE/AFTER, from a dry run in the caller's scratch. */
    structure?: StructurePreview;
    /** Scratch DROP TABLE: the rows the table holds now, lost with it. */
    lostRows?: number;
    /** CREATE TABLE tmp_… AS reading Sankhya: each part copied for the preview. */
    sankhyaParts?: SankhyaPart[];
  };
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
  /** The row before the change, restricted to the written fields; null for an INSERT. */
  before?: Record<string, unknown> | null;
  /** What the plan meant to write. */
  expected?: Record<string, unknown>;
  /** The written fields as the server read them back; absent when they could not be read. */
  observed?: Record<string, unknown>;
}

/** Answer of POST /api/query/execute. */
export interface ExecutionReport {
  type: 'execution';
  planId: string;
  status: 'success' | 'partial' | 'failed';
  verification: VerificationLabel;
  steps: ExecutionStep[];
  /** Replays only: some row values were clipped or left out of the stored report. */
  valuesTruncated?: boolean;
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
