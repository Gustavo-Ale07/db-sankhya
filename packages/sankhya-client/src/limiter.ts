import { AppError } from '@dbx/shared';

export type Release = () => void;

/** Counting semaphore with FIFO fairness and abort support. */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<{ resolve: (r: Release) => void; reject: (e: unknown) => void }> =
    [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    return new Promise<Release>((resolve, reject) => {
      const entry = {
        resolve: (r: Release) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(r);
        },
        reject,
      };
      const onAbort = () => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(abortError(signal));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private makeRelease(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) next.resolve(this.makeRelease());
      else this.active -= 1;
    };
  }
}

/**
 * Token bucket on ERP API calls per minute, shared by the whole process: keeps heavy scans from
 * burning the integration's quota (gateways throttle or block clients that exceed it). Callers
 * wait in FIFO order; the wait
 * is abortable, so query timeouts and cancellation still apply.
 */
export class CallRateLimiter {
  private tokens: number;
  private last: number;
  private tail: Promise<void> = Promise.resolve();
  private readonly capacity: number;
  private readonly perMs: number;

  constructor(
    readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    if (!Number.isInteger(perMinute) || perMinute < 1)
      throw new Error('perMinute must be a positive integer');
    this.capacity = Math.max(1, Math.floor(perMinute / 6));
    this.tokens = this.capacity;
    this.perMs = perMinute / 60_000;
    this.last = now();
  }

  /** Resolves when the caller may make one call. */
  take(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const turn = this.tail.then(() => this.wait(signal));
    // A cancelled waiter must not block the ones behind it (it skips its turn without a token).
    this.tail = turn.catch(() => undefined);
    if (!signal) return turn;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(signal));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([turn, aborted]).finally(() =>
      signal.removeEventListener('abort', onAbort),
    );
  }

  private async wait(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortError(signal);
      const now = this.now();
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.last) * this.perMs);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.sleep(Math.ceil((1 - this.tokens) / this.perMs), signal);
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Maps an abort reason to the matching typed error. */
export function abortError(signal: AbortSignal | undefined): AppError {
  const reason: unknown = signal?.reason;
  if (reason instanceof AppError) return reason;
  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return new AppError('QUERY_TIMEOUT', 'The query exceeded its time limit');
  }
  return new AppError('QUERY_CANCELLED', 'The query was cancelled');
}

/** Maps `items` through `fn` with at most `concurrency` in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed) {
      if (signal?.aborted) throw abortError(signal);
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker);
  await Promise.all(workers);
  return results;
}
