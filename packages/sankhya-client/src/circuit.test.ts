import { describe, expect, it, vi } from 'vitest';
import { AppError, isAppError } from '@dbx/shared';
import { CircuitBreaker } from './circuit';

const boom = () => Promise.reject(new Error('upstream down'));

function clock(start = 1_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

async function failTimes(breaker: CircuitBreaker, n: number) {
  for (let i = 0; i < n; i++) await expect(breaker.run(boom)).rejects.toThrow('upstream down');
}

describe('CircuitBreaker', () => {
  it('opens after N consecutive failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetAfterMs: 10_000 });
    await failTimes(breaker, 3);
    expect(breaker.state()).toBe('OPEN');
    const fn = vi.fn(() => Promise.resolve('x'));
    const err: unknown = await breaker.run(fn).catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('SANKHYA_UNAVAILABLE');
    expect(fn).not.toHaveBeenCalled();
  });

  it('resets the failure count after a success', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetAfterMs: 10_000 });
    await failTimes(breaker, 2);
    await breaker.run(() => Promise.resolve(1));
    await failTimes(breaker, 2);
    expect(breaker.state()).toBe('CLOSED');
  });

  it('half-opens after resetAfterMs and closes on success', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, now: c.now });
    await failTimes(breaker, 2);
    c.advance(4_999);
    expect(breaker.state()).toBe('OPEN');
    c.advance(1);
    expect(breaker.state()).toBe('HALF_OPEN');
    await expect(breaker.run(() => Promise.resolve('ok'))).resolves.toBe('ok');
    expect(breaker.state()).toBe('CLOSED');
  });

  it('re-opens on failure while half-open', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 5_000, now: c.now });
    await failTimes(breaker, 2);
    c.advance(5_000);
    await expect(breaker.run(boom)).rejects.toThrow('upstream down');
    expect(breaker.state()).toBe('OPEN');
    c.advance(4_999);
    expect(breaker.state()).toBe('OPEN');
  });

  it('allows exactly one trial call while half-open', async () => {
    const c = clock();
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 1_000, now: c.now });
    await failTimes(breaker, 1);
    c.advance(1_000);
    let release: (v: string) => void = () => undefined;
    const trial = breaker.run(() => new Promise<string>((r) => (release = r)));
    const second: unknown = await breaker.run(() => Promise.resolve('y')).catch((e: unknown) => e);
    expect(isAppError(second) && second.code).toBe('SANKHYA_UNAVAILABLE');
    release('trial');
    await expect(trial).resolves.toBe('trial');
    expect(breaker.state()).toBe('CLOSED');
  });

  it('business errors do not count', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetAfterMs: 1_000 });
    const business = () => Promise.reject(new AppError('SANKHYA_API_ERROR', 'rejected'));
    const isFailure = (e: unknown) => !(isAppError(e) && e.code === 'SANKHYA_API_ERROR');
    for (let i = 0; i < 5; i++) await expect(breaker.run(business, isFailure)).rejects.toThrow();
    expect(breaker.state()).toBe('CLOSED');
  });

  it('rejects invalid options', () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, resetAfterMs: 1 })).toThrow();
    expect(() => new CircuitBreaker({ failureThreshold: 1, resetAfterMs: -1 })).toThrow();
  });
});
