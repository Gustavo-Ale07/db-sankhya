import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
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
