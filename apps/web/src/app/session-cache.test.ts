import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { getPendingPlan, rememberPlan } from '../explorer/pendingPlans';
import { resetSessionCache } from './session-cache';

describe('resetSessionCache', () => {
  it('drops per-user queries such as the schema catalog and signs the user out', () => {
    const qc = new QueryClient();
    qc.setQueryData(['schema', 'env-default'], { connectionId: 'env-default', catalog: {} });
    qc.setQueryData(['history'], []);
    qc.setQueryData(['me'], { user: { id: 'u1' } });

    resetSessionCache(qc);

    expect(qc.getQueryData(['schema', 'env-default'])).toBeUndefined();
    expect(qc.getQueryData(['history'])).toBeUndefined();
    expect(qc.getQueryData(['me'])).toBeNull();
  });

  it('forgets every pending mutation plan (token and idempotency key) on logout', () => {
    rememberPlan({
      planId: 'p1',
      preview: {
        planId: 'p1',
        token: 'plan-token-secret',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        capability: { class: 'SUPPORTED', route: 'SANKHYA_SAVE', reason: 'x' },
        previewKind: 'IMPACT_ANALYSIS',
        previewLabels: [],
        preview: { targets: [], affected: 0 },
        impact: { entities: [], rows: 0, environment: 'PRODUCTION' },
        requires: { strongConfirmation: null, approval: true },
      },
      idempotencyKey: 'key-1',
      connectionId: 'env',
      sql: 'UPDATE X SET A = 1 WHERE B = 1',
      tabId: 't1',
      approvalRequested: true,
    });

    resetSessionCache(new QueryClient());

    expect(getPendingPlan('p1')).toBeUndefined();
  });
});

describe('resetSessionCache, observed session', () => {
  it('keeps the observed session query, so its observer sees the sign-out', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['me'], { user: { id: 'u1' } });
    const observed = qc.getQueryCache().find({ queryKey: ['me'], exact: true });
    const seen: unknown[] = [];
    const observer = new QueryObserver(qc, {
      queryKey: ['me'],
      queryFn: () => null,
      staleTime: Infinity,
    });
    const stop = observer.subscribe((r) => seen.push(r.data));

    resetSessionCache(qc);

    expect(qc.getQueryCache().find({ queryKey: ['me'], exact: true })).toBe(observed);
    expect(observer.getCurrentResult().data).toBeNull();
    expect(seen.at(-1)).toBeNull();
    stop();
  });
});
