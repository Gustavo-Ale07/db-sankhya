import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
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
