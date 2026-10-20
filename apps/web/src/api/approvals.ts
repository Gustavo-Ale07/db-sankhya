import { api } from './client';
import type { Permission } from './types';

export type ApprovalDecision = 'APPROVE' | 'REJECT';

/** A pending approval the caller may decide. `sql` and `preview` appear only when readable. */
export interface PendingApproval {
  id: string;
  planId: string;
  planHash: string;
  requestedBy: string;
  /** Display name of the requester; null when the account no longer exists. */
  requestedByName?: string | null;
  createdAt: string;
  expiresAt: string;
  plan: {
    environment: string;
    connectionId: string;
    previewKind: string;
    action: Permission;
    entities: string[];
    targetCount: number | null;
    sql?: string;
    preview?: unknown;
  };
}

export const listPendingApprovals = () =>
  api.get<{ items: PendingApproval[] }>('/api/approvals/pending');

export const decideApproval = (id: string, decision: ApprovalDecision, reason?: string | null) =>
  api.post<unknown>(`/api/approvals/${encodeURIComponent(id)}/decision`, {
    decision,
    reason: reason?.trim() ? reason.trim() : null,
  });
