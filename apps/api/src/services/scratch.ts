/**
 * Per-user scratch workspaces. Each workspace is an isolated in-memory PGlite in its own worker
 * thread (see scratch-worker.ts), so users never share tables and a runaway statement cannot
 * block the API: the host enforces the statement timeout by terminating the worker, which also
 * resets that workspace. Statements go through the AST gate in scratch-guard.ts first.
 */
import { Worker } from 'node:worker_threads';
import { AppError } from '@dbx/shared';
import { analyzeScratchSql, assertScratchTableName } from './scratch-guard';
import type { ScratchStatement } from './scratch-guard';
import type { Limits, WorkerRequest, WorkerResponse } from './scratch-worker';

export type ScratchColumnType = 'text' | 'numeric' | 'timestamp' | 'boolean';

export interface ScratchManagerOptions {
  maxWorkspaces: number;
  /** Rows across all tables of one workspace. */
  maxRows: number;
  maxTables: number;
  ttlMinutes: number;
  statementTimeoutMs: number;
  /** Rows returned by one SELECT (default: maxRows). */
  maxResultRows?: number;
  /** Rows shown on each side of a transactional dry run (default 200). */
  previewRows?: number;
  /** Background eviction period; 0 disables it (default 60 s). */
  sweepIntervalMs?: number;
  now?: () => number;
}

export interface ScratchResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  command: string;
  truncated: boolean;
}

export interface ScratchSnapshot {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export interface DryRunResult {
  table: string;
  before: ScratchSnapshot;
  after: ScratchSnapshot;
  rowCount: number;
}

const COLUMN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const STARTUP_TIMEOUT_MS = 30_000;

type Op = WorkerRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

interface Slot {
  worker: Worker;
  ready: Promise<void>;
  pending: Map<number, Pending>;
}

/** One worker thread with a serialized request queue and a hard per-request timeout. */
class WorkerHost {
  private slot: Slot | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private nextId = 1;

  constructor(private readonly timeoutMs: number) {}

  run<T>(op: Op, signal?: AbortSignal): Promise<T> {
    const task = this.queue.then(() => this.send<T>(op, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  async close(): Promise<void> {
    const slot = this.slot;
    if (slot) await this.reset(slot);
  }

  private start(): Slot {
    if (this.slot) return this.slot;
    const worker = new Worker(workerUrl(), { resourceLimits: { maxOldGenerationSizeMb: 512 } });
    worker.unref();
    const pending = new Map<number, Pending>();
    let markReady: () => void = () => {};
    let failStart: (e: unknown) => void = () => {};
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      failStart = reject;
    });
    ready.catch(() => undefined);
    const slot: Slot = { worker, ready, pending };

    const timer = setTimeout(() => {
      failStart(new AppError('INTERNAL_ERROR', 'The scratch workspace did not start.'));
      void this.reset(slot);
    }, STARTUP_TIMEOUT_MS);
    timer.unref();

    worker.on('message', (msg: WorkerResponse) => {
      if ('ready' in msg) {
        clearTimeout(timer);
        markReady();
        return;
      }
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.result);
      else {
        const details = msg.error.sqlState ? { sqlState: msg.error.sqlState } : undefined;
        entry.reject(new AppError(msg.error.code, msg.error.message, details));
      }
    });
    const fail = (err: unknown) => {
      clearTimeout(timer);
      const oom = (err as { code?: unknown } | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      const error = oom
        ? new AppError(
            'QUERY_LIMIT_EXCEEDED',
            'The statement used too much memory; the workspace was reset.',
          )
        : new AppError('INTERNAL_ERROR', 'The scratch workspace stopped; it was reset.');
      failStart(error);
      if (this.slot === slot) this.slot = null;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', () => fail(undefined));
    this.slot = slot;
    return slot;
  }

  private async send<T>(op: Op, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new AppError('QUERY_CANCELLED', 'The query was cancelled.');
    const slot = this.start();
    await slot.ready;
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        slot.pending.delete(id);
        fn();
      };
      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new AppError(
              'QUERY_TIMEOUT',
              `The scratch statement exceeded ${this.timeoutMs} ms; the workspace was reset.`,
            ),
          ),
        );
        void this.reset(slot);
      }, this.timeoutMs);
      const onAbort = () => {
        settle(() =>
          reject(
            new AppError('QUERY_CANCELLED', 'The query was cancelled; the workspace was reset.'),
          ),
        );
        void this.reset(slot);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      slot.pending.set(id, {
        resolve: (v) => settle(() => resolve(v as T)),
        reject: (e) => settle(() => reject(e)),
      });
      slot.worker.postMessage({ ...op, id } as WorkerRequest);
    });
  }

  private async reset(slot: Slot): Promise<void> {
    if (this.slot === slot) this.slot = null;
    await slot.worker.terminate();
  }
}

function workerUrl(): URL {
  // Sources run with Node's type stripping; the production bundle ships scratch-worker.mjs.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.mjs';
  return new URL(`./scratch-worker${ext}`, import.meta.url);
}

export class ScratchWorkspace {
  private lastUsed: number;
  private active = 0;
  private closed = false;

  /** @internal Created by ScratchManager. */
  constructor(
    private readonly host: WorkerHost,
    private readonly limits: Limits,
    private readonly previewRows: number,
    private readonly now: () => number,
  ) {
    this.lastUsed = now();
  }

  /** Validates and runs one statement. */
  async exec(sql: string, signal?: AbortSignal): Promise<ScratchResult> {
    return this.execStatement(analyzeScratchSql(sql), signal);
  }

  /** Runs a statement already analyzed with `analyzeScratchSql` (and authorized by the caller). */
  async execStatement(stmt: ScratchStatement, signal?: AbortSignal): Promise<ScratchResult> {
    const res = await this.use(() =>
      this.host.run<Omit<ScratchResult, 'command'>>(
        { op: 'exec', sql: stmt.sql, mutating: stmt.mutating, limits: this.limits },
        signal,
      ),
    );
    return { ...res, command: stmt.command };
  }

  tables(): Promise<Array<{ name: string; rows: number }>> {
    return this.use(() => this.host.run({ op: 'tables' }));
  }

  /** Creates (or replaces) `table` with the given columns and rows, within the quotas. */
  async importRows(
    table: string,
    columns: Array<{ name: string; type: ScratchColumnType }>,
    rows: unknown[][],
  ): Promise<void> {
    assertScratchTableName(table);
    if (columns.length === 0 || columns.length > 200) {
      throw new AppError('VALIDATION_ERROR', 'A scratch table needs between 1 and 200 columns.');
    }
    const seen = new Set<string>();
    for (const c of columns) {
      if (!COLUMN_NAME.test(c.name) || seen.has(c.name)) {
        throw new AppError(
          'VALIDATION_ERROR',
          `Invalid or duplicate column name "${c.name.slice(0, 64)}".`,
        );
      }
      seen.add(c.name);
    }
    if (rows.length > this.limits.maxRows) {
      throw new AppError(
        'QUERY_LIMIT_EXCEEDED',
        `The workspace is limited to ${this.limits.maxRows} rows in total.`,
      );
    }
    await this.use(() =>
      this.host.run({ op: 'import', table, columns, rows, limits: this.limits }),
    );
  }

  /** BEGIN, run the write, capture the target table before and after, ROLLBACK. */
  async transactionalDryRun(sql: string): Promise<DryRunResult> {
    const stmt = analyzeScratchSql(sql);
    if (!['INSERT', 'UPDATE', 'DELETE'].includes(stmt.command) || stmt.target === null) {
      throw new AppError('VALIDATION_ERROR', 'A dry run needs an INSERT, UPDATE or DELETE.');
    }
    const target = stmt.target;
    const res = await this.use(() =>
      this.host.run<Omit<DryRunResult, 'table'>>({
        op: 'dryRun',
        sql: stmt.sql,
        target,
        previewRows: this.previewRows,
      }),
    );
    return { table: target, ...res };
  }

  /** @internal */
  idleSince(): number | null {
    return this.active > 0 ? null : this.lastUsed;
  }

  /** @internal Once closed (evicted, discarded), the workspace never starts a database again. */
  close(): Promise<void> {
    this.closed = true;
    return this.host.close();
  }

  private async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) {
      throw new AppError('NOT_FOUND', 'The scratch workspace expired; open a new one.');
    }
    this.active += 1;
    this.lastUsed = this.now();
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.lastUsed = this.now();
    }
  }
}

export class ScratchManager {
  private readonly workspaces = new Map<string, ScratchWorkspace>();
  private readonly now: () => number;
  private readonly sweeper: NodeJS.Timeout | null;

  constructor(private readonly opts: ScratchManagerOptions) {
    this.now = opts.now ?? Date.now;
    const every = opts.sweepIntervalMs ?? 60_000;
    this.sweeper = every > 0 ? setInterval(() => void this.evictIdle(), every) : null;
    this.sweeper?.unref();
  }

  async workspace(userId: string): Promise<ScratchWorkspace> {
    if (!userId) throw new AppError('VALIDATION_ERROR', 'A scratch workspace needs a user.');
    const existing = this.workspaces.get(userId);
    if (existing) return existing;
    if (this.workspaces.size >= this.opts.maxWorkspaces) {
      await this.evictIdle();
      // Another request for this user may have created it while eviction ran.
      const created = this.workspaces.get(userId);
      if (created) return created;
    }
    if (this.workspaces.size >= this.opts.maxWorkspaces) {
      throw new AppError('RATE_LIMITED', 'All scratch workspaces are in use. Try again later.');
    }
    const ws = new ScratchWorkspace(
      new WorkerHost(this.opts.statementTimeoutMs),
      {
        maxRows: this.opts.maxRows,
        maxTables: this.opts.maxTables,
        maxResultRows: this.opts.maxResultRows ?? this.opts.maxRows,
      },
      this.opts.previewRows ?? 200,
      this.now,
    );
    this.workspaces.set(userId, ws);
    return ws;
  }

  /** Closes workspaces idle for longer than the TTL. Returns how many were closed. */
  async evictIdle(): Promise<number> {
    const cutoff = this.now() - this.opts.ttlMinutes * 60_000;
    const stale: ScratchWorkspace[] = [];
    for (const [user, ws] of this.workspaces) {
      const idle = ws.idleSince();
      if (idle !== null && idle <= cutoff) {
        this.workspaces.delete(user);
        stale.push(ws);
      }
    }
    await Promise.all(stale.map((ws) => ws.close()));
    return stale.length;
  }

  /** Drops one user's workspace and all its tables. */
  async discard(userId: string): Promise<void> {
    const ws = this.workspaces.get(userId);
    if (!ws) return;
    this.workspaces.delete(userId);
    await ws.close();
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.workspaces.values()];
    this.workspaces.clear();
    await Promise.all(all.map((ws) => ws.close()));
  }

  stats(): { workspaces: number } {
    return { workspaces: this.workspaces.size };
  }
}
