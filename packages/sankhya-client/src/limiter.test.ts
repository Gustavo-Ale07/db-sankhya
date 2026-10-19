import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { CallRateLimiter, ConcurrencyLimiter, abortError, mapWithConcurrency } from './limiter';

const tick = () => new Promise((r) => setTimeout(r, 1));

describe('ConcurrencyLimiter', () => {
  it('never exceeds the limit and runs FIFO', async () => {
    const limiter = new ConcurrencyLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        limiter.run(async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          order.push(i);
          await tick();
          inFlight--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(limiter.running).toBe(0);
  });

  it('removes aborted waiters from the queue', async () => {
    const limiter = new ConcurrencyLimiter(1);
    const release = await limiter.acquire();
    const ac = new AbortController();
    const waiting = limiter.acquire(ac.signal);
    expect(limiter.pending).toBe(1);
    ac.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'QUERY_CANCELLED' });
    expect(limiter.pending).toBe(0);
    release();
    release(); // idempotent
    expect(limiter.running).toBe(0);
  });

  it('rejects invalid limits', () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });
});

describe('abortError', () => {
  it('maps timeouts and cancellation', () => {
    expect(abortError(AbortSignal.abort(new DOMException('t', 'TimeoutError'))).code).toBe(
      'QUERY_TIMEOUT',
    );
    expect(abortError(AbortSignal.abort()).code).toBe('QUERY_CANCELLED');
    const e = abortError(AbortSignal.abort());
    expect(isAppError(e)).toBe(true);
  });
});

describe('mapWithConcurrency', () => {
  it('preserves order and respects concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('stops scheduling after a failure', async () => {
    const seen: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
    expect(seen).toEqual([1, 2]);
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 3, async () => 1)).toEqual([]);
  });
});

describe('CallRateLimiter', () => {
  function fakeClock() {
    let now = 0;
    const slept: number[] = [];
    const sleep = (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    };
    return { now: () => now, sleep, slept, elapsed: () => now };
  }

  it('allows a burst, then paces calls to the configured rate', async () => {
    const clock = fakeClock();
    const limiter = new CallRateLimiter(60, clock.now, clock.sleep); // 1/s, burst of 10
    for (let i = 0; i < 10; i++) await limiter.take();
    expect(clock.elapsed()).toBe(0);
    for (let i = 0; i < 5; i++) await limiter.take();
    expect(clock.elapsed()).toBe(5000);
  });

  it('rejects aborted callers without consuming a token', async () => {
    const clock = fakeClock();
    const limiter = new CallRateLimiter(6, clock.now, clock.sleep); // burst of 1
    const controller = new AbortController();
    controller.abort();
    await expect(limiter.take(controller.signal)).rejects.toSatisfy(isAppError);
    await limiter.take();
    expect(clock.elapsed()).toBe(0);
  });
});
