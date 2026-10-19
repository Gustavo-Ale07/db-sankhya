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
  log?: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
  exit: (code: number) => void;
}

/** Idempotent graceful shutdown: drain in-flight requests (bounded), then close the pool. */
export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  const { app, closeDatabase, timeoutMs, log, exit } = options;
  let closing = false;
  return async (signal) => {
    if (closing) return;
    closing = true;
    log?.info({ signal }, 'shutting down');
    let code = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      const drained = app.close().then(() => 'drained' as const);
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      if ((await Promise.race([drained, expired])) === 'timeout') {
        log?.warn({ timeoutMs }, 'shutdown grace period exceeded; closing connections');
        code = 1;
        app.forceClose?.();
        // Connections are gone now, so close() can finish its hooks.
        const cap = new Promise((r) => setTimeout(r, 2000).unref());
        await Promise.race([drained, cap]);
      }
    } catch (err) {
      log?.warn({ err }, 'error while closing the app');
      code = 1;
    } finally {
      if (timer) clearTimeout(timer);
      try {
        await closeDatabase();
      } catch (err) {
        log?.warn({ err }, 'error while closing the database');
        code = 1;
      }
      exit(code);
    }
  };
}
