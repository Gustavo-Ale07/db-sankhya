import { useSyncExternalStore } from 'react';
import type { PreparedPlan } from '../api/mutations';
import type { MutationOutcome } from './runState';

/**
 * How long a plan whose outcome is unknown stays reopenable after its own expiry. The server
 * replays the recorded result of a consumed plan for the same idempotency key even after the
 * plan expired, so "Consultar resultado" stays meaningful for a while; then the entry goes.
 */
export const UNKNOWN_OUTCOME_GRACE_MS = 30 * 60_000;

/**
 * A mutation plan that can still be executed (or replayed) from this browser tab: waiting for its
 * confirmation, for an approval, or for the same-key resend after an unknown outcome. The plan
 * token travels inside `preview` (`preview.token`).
 *
 * It lives in this module's memory only: never in localStorage, sessionStorage, IndexedDB or a
 * log. It is dropped on a final outcome, when its TTL ends and on logout (resetSessionCache).
 */
export interface PendingPlan {
  planId: string;
  preview: PreparedPlan;
  /** One key per plan: every execute and every resend of this plan reuses it. */
  idempotencyKey: string;
  /** The connection the plan was prepared on; it is reopened only while that one is selected. */
  connectionId: string;
  sql: string;
  /** The editor tab whose status area shows the plan. */
  tabId: string;
  approvalRequested: boolean;
  outcome?: MutationOutcome;
}

const plans = new Map<string, PendingPlan>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function deadline(p: PendingPlan): number {
  const end = Date.parse(p.preview.expiresAt);
  if (Number.isNaN(end)) return 0;
  return p.outcome?.unknown ? end + UNKNOWN_OUTCOME_GRACE_MS : end;
}

function schedule(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  let next = Infinity;
  for (const p of plans.values()) next = Math.min(next, deadline(p));
  if (next === Infinity) return;
  timer = setTimeout(
    () => {
      timer = undefined;
      prune(Date.now());
    },
    Math.max(0, next - Date.now()),
  );
}

function emit(): void {
  schedule();
  for (const l of [...listeners]) l();
}

function prune(now: number): void {
  let changed = false;
  for (const [id, p] of plans) {
    if (deadline(p) <= now) {
      plans.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
  else schedule();
}

export function rememberPlan(plan: PendingPlan): void {
  plans.set(plan.planId, plan);
  emit();
}

export function updatePlan(
  planId: string,
  patch: Partial<Pick<PendingPlan, 'approvalRequested' | 'outcome'>>,
): void {
  const p = plans.get(planId);
  if (!p) return;
  plans.set(planId, { ...p, ...patch });
  emit();
}

export function dropPlan(planId: string): void {
  if (plans.delete(planId)) emit();
}

/** The plan, unless it was dropped or its TTL already ended. */
export function getPendingPlan(planId: string): PendingPlan | undefined {
  const p = plans.get(planId);
  if (p && deadline(p) <= Date.now()) {
    prune(Date.now());
    return undefined;
  }
  return p;
}

/** Forgets every plan, its token and its idempotency key (logout, session end). */
export function clearPendingPlans(): void {
  plans.clear();
  emit();
}

export function subscribePendingPlans(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pending plan with this id, re-rendering when it changes, is dropped or expires. */
export function usePendingPlan(planId: string | undefined): PendingPlan | undefined {
  return useSyncExternalStore(subscribePendingPlans, () =>
    planId === undefined ? undefined : plans.get(planId),
  );
}
