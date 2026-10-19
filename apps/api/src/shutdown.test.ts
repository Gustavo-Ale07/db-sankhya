import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from './shutdown';

describe('createShutdown', () => {
  it('closes the app, then the database, then exits 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    await createShutdown({
      app: { close: async () => void order.push('app') },
      closeDatabase: async () => void order.push('db'),
      timeoutMs: 1000,
      exit,
    })('SIGTERM');
    expect(order).toEqual(['app', 'db']);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('a second signal while closing warns and forces exit(1)', async () => {
    const exit = vi.fn();
    const warn = vi.fn();
    const shutdown = createShutdown({
      app: { close: () => new Promise(() => {}) },
      closeDatabase: async () => {},
      timeoutMs: 60_000,
      log: { info: vi.fn(), warn },
      exit,
    });
    void shutdown('SIGTERM');
    await shutdown('SIGINT');
    expect(warn).toHaveBeenCalled();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits 1 even when closing the database never resolves', async () => {
    const exit = vi.fn();
    await createShutdown({
      app: { close: async () => {} },
      closeDatabase: () => new Promise(() => {}),
      timeoutMs: 1000,
      dbCloseTimeoutMs: 20,
      exit,
    })('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
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
