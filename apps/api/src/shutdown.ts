export interface ShutdownTarget {
  /** Stops accepting connections and waits for in-flight requests (and runs onClose hooks). */
  close(): Promise<unknown>;
  /** Drops whatever is still open once the grace period is over. */
  forceClose?(): void;
}

export interface ShutdownOptions {
  app: ShutdownTarget;
  /** Closed after the app, so no request can still need it. */
  closeDatabase: () => Promise<void>;
  /** Upper bound for in-flight requests to finish. */
  timeoutMs: number;
  /** Upper bound for closing the database pool. */
  dbCloseTimeoutMs?: number;
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  exit: (code: number) => void;
}

/** Resolves with the promise's outcome, or 'timeout'; always clears its timer. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Graceful shutdown: drain in-flight requests (bounded), close the pool (bounded), then exit.
 * A second signal while closing forces an immediate exit(1).
 */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { app, closeDatabase, timeoutMs, log, exit } = options;
  const dbCloseTimeoutMs = options.dbCloseTimeoutMs ?? 3000;
  let closing = false;
  return async (signal) => {
    if (closing) {
      log?.warn({ signal }, 'second signal received during shutdown; forcing exit');
      exit(1);
      return;
    }
    closing = true;
    log?.info({ signal }, 'shutting down');
    let code = 0;
    try {
      const drained = app.close();
      // A rejection after the race is settled must not become unhandled.
      drained.catch(() => {});
      if ((await within(drained, timeoutMs)) === 'timeout') {
        log?.warn({ timeoutMs }, 'shutdown grace period exceeded; closing connections');
        code = 1;
        app.forceClose?.();
        await within(drained, 2000);
      }
    } catch (err) {
      log?.warn({ err }, 'error while closing the app');
      code = 1;
    }
    try {
      if ((await within(closeDatabase(), dbCloseTimeoutMs)) === 'timeout') {
        log?.warn({ dbCloseTimeoutMs }, 'database close timed out');
        code = 1;
      }
    } catch (err) {
      log?.warn({ err }, 'error while closing the database');
      code = 1;
    }
    exit(code);
  };
}
