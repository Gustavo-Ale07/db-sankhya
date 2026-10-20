import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedPlan } from '../api/mutations';
import {
  UNKNOWN_OUTCOME_GRACE_MS,
  clearPendingPlans,
  dropPlan,
  getPendingPlan,
  rememberPlan,
  subscribePendingPlans,
  updatePlan,
} from './pendingPlans';
import type { PendingPlan } from './pendingPlans';

const NOW = Date.parse('2026-01-01T10:00:00.000Z');
const TOKEN = 'plan-token-secret';

function plan(over: Partial<PendingPlan> = {}): PendingPlan {
  const preview: PreparedPlan = {
    planId: 'p1',
    token: TOKEN,
    expiresAt: new Date(NOW + 60_000).toISOString(),
    capability: { class: 'SUPPORTED', route: 'SANKHYA_SAVE', reason: 'x' },
    previewKind: 'IMPACT_ANALYSIS',
    previewLabels: ['IMPACT_ANALYSIS'],
    preview: { targets: [], affected: 0 },
    impact: { entities: ['TGFPAR'], rows: 1, environment: 'PRODUCTION' },
    requires: { strongConfirmation: null, approval: true },
  };
  return {
    planId: 'p1',
    preview,
    idempotencyKey: 'key-1',
    connectionId: 'env',
    sql: 'UPDATE TGFPAR SET NOMEPARC = 1 WHERE CODPARC = 1',
    tabId: 't1',
    approvalRequested: false,
    ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
  clearPendingPlans();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('pending plans store', () => {
  it('keeps a plan in memory until it is dropped', () => {
    rememberPlan(plan());
    expect(getPendingPlan('p1')?.idempotencyKey).toBe('key-1');
    updatePlan('p1', { approvalRequested: true });
    expect(getPendingPlan('p1')?.approvalRequested).toBe(true);
    dropPlan('p1');
    expect(getPendingPlan('p1')).toBeUndefined();
  });

  it('notifies subscribers of every change', () => {
    const seen = vi.fn();
    const stop = subscribePendingPlans(seen);
    rememberPlan(plan());
    updatePlan('p1', { approvalRequested: true });
    dropPlan('p1');
    expect(seen).toHaveBeenCalledTimes(3);
    stop();
  });

  it('drops a plan when its TTL expires', () => {
    const seen = vi.fn();
    const stop = subscribePendingPlans(seen);
    rememberPlan(plan());
    seen.mockClear();
    vi.advanceTimersByTime(59_000);
    expect(getPendingPlan('p1')).toBeDefined();
    vi.advanceTimersByTime(1_000);
    expect(getPendingPlan('p1')).toBeUndefined();
    expect(seen).toHaveBeenCalled();
    stop();
  });

  it('keeps an unknown-outcome plan past the plan expiry, for the same-key replay, then drops it', () => {
    rememberPlan(plan({ outcome: { sent: true, unknown: true, errorCode: 'NETWORK_ERROR' } }));
    vi.advanceTimersByTime(60_000);
    expect(getPendingPlan('p1')).toBeDefined();
    vi.advanceTimersByTime(UNKNOWN_OUTCOME_GRACE_MS);
    expect(getPendingPlan('p1')).toBeUndefined();
  });

  it('clearPendingPlans forgets every plan', () => {
    rememberPlan(plan());
    rememberPlan(plan({ planId: 'p2' }));
    clearPendingPlans();
    expect(getPendingPlan('p1')).toBeUndefined();
    expect(getPendingPlan('p2')).toBeUndefined();
  });

  it('never writes to web storage or IndexedDB', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const open = globalThis.indexedDB ? vi.spyOn(globalThis.indexedDB, 'open') : undefined;
    rememberPlan(plan());
    updatePlan('p1', { outcome: { sent: true, unknown: true, errorCode: 'NETWORK_ERROR' } });
    getPendingPlan('p1');
    dropPlan('p1');
    expect(setItem).not.toHaveBeenCalled();
    if (open) expect(open).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });
});
