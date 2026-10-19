import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionOption } from '../api/types';
import { loadSelectedConnection, resolveConnection, saveSelectedConnection } from './connection';

const list: ConnectionOption[] = [
  { id: 'a', name: 'A', environment: 'SANDBOX' },
  { id: 'b', name: 'B', environment: 'PRODUCTION' },
];

describe('resolveConnection', () => {
  it('keeps the remembered connection while it is listed', () => {
    expect(resolveConnection(list, 'b')?.environment).toBe('PRODUCTION');
  });
  it('falls back to the first one when it is gone or unset', () => {
    expect(resolveConnection(list, 'zzz')?.id).toBe('a');
    expect(resolveConnection(list, null)?.id).toBe('a');
  });
  it('is undefined with nothing to pick', () => {
    expect(resolveConnection([], 'a')).toBeUndefined();
    expect(resolveConnection(undefined, 'a')).toBeUndefined();
  });
});

describe('selected connection storage', () => {
  beforeEach(() => window.localStorage.clear());
  it('round-trips and clears', () => {
    expect(loadSelectedConnection()).toBeNull();
    saveSelectedConnection('b');
    expect(loadSelectedConnection()).toBe('b');
    saveSelectedConnection(null);
    expect(loadSelectedConnection()).toBeNull();
  });
});
