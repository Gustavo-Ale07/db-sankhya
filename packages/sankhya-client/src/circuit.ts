import { AppError } from '@dbx/shared';

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Consecutive infrastructure failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is let through. */
  resetAfterMs: number;
  now?: () => number;
}

/**
 * Stops hammering a gateway that is down. Only infrastructure failures count (the caller decides
 * through `isFailure`): a business rejection proves the gateway is answering. While half-open,
 * exactly one trial call runs; concurrent callers fail fast.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private trialInFlight = false;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    if (!Number.isInteger(opts.failureThreshold) || opts.failureThreshold < 1)
      throw new Error('failureThreshold must be a positive integer');
    if (!Number.isFinite(opts.resetAfterMs) || opts.resetAfterMs < 0)
      throw new Error('resetAfterMs must be a non-negative number');
    this.now = opts.now ?? Date.now;
  }

  state(): CircuitState {
    if (this.openedAt === undefined) return 'CLOSED';
    return this.now() - this.openedAt >= this.opts.resetAfterMs ? 'HALF_OPEN' : 'OPEN';
  }

  async run<T>(fn: () => Promise<T>, isFailure: (e: unknown) => boolean = () => true): Promise<T> {
    const state = this.state();
    if (state === 'OPEN' || (state === 'HALF_OPEN' && this.trialInFlight)) {
      throw new AppError(
        'SANKHYA_UNAVAILABLE',
        'The Sankhya gateway is failing; calls are paused for a moment.',
      );
    }
    const trial = state === 'HALF_OPEN';
    if (trial) this.trialInFlight = true;
    try {
      const result = await fn();
      this.close();
      return result;
    } catch (err) {
      if (isFailure(err)) this.recordFailure(trial);
      else this.close();
      throw err;
    } finally {
      if (trial) this.trialInFlight = false;
    }
  }

  private close(): void {
    this.failures = 0;
    this.openedAt = undefined;
  }

  private recordFailure(trial: boolean): void {
    this.failures += 1;
    if (trial || this.failures >= this.opts.failureThreshold) this.openedAt = this.now();
  }
}
