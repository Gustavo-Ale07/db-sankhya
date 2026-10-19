import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

describe('createShutdown', () => {
  it('closes the app, then the database, then exits 0; a second signal is ignored', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const shutdown = createShutdown({
      app: { close: async () => void order.push('app') },
      closeDatabase: async () => void order.push('db'),
      timeoutMs: 1000,
      exit,
    });
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(order).toEqual(['app', 'db']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forces connections closed after the timeout, still closes the database and exits 1', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    const forceClose = vi.fn(() => release());
    const closeDatabase = vi.fn(async () => {});
    const exit = vi.fn();
    await createShutdown({
      app: { close: () => hang, forceClose },
      closeDatabase,
      timeoutMs: 20,
      exit,
    })('SIGTERM');
    expect(forceClose).toHaveBeenCalled();
    expect(closeDatabase).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('closes the database and exits 1 when the app fails to close', async () => {
    const closeDatabase = vi.fn(async () => {});
    const exit = vi.fn();
    await createShutdown({
      app: {
        close: async () => {
          throw new Error('boom');
        },
      },
      closeDatabase,
      timeoutMs: 1000,
      exit,
    })('SIGTERM');
    expect(closeDatabase).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
