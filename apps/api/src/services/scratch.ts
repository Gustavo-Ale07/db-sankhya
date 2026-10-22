/**
 * Per-user scratch workspaces. Each workspace is an isolated in-memory PGlite in its own worker
 * thread (see scratch-worker.ts), so users never share tables and a runaway statement cannot
 * block the API: the host enforces the statement timeout by terminating the worker, which also
 * resets that workspace. Statements go through the AST gate in scratch-guard.ts first.
 *
 * Memory: each worker caps its V8 heap at 512 MiB, but PGlite's WASM linear memory lives outside
 * that cap. Stored data is bounded by `maxBytes` (checked after every write) and a worker whose
 * WASM memory grows past `maxWasmMemoryBytes` is recycled (its workspace starts empty again).
 * Worst case per process is therefore about maxWorkspaces x (512 MiB + maxWasmMemoryBytes),
 * plus one statement's transient overshoot before the check runs.
 */
import { Worker } from 'node:worker_threads';
import { AppError } from '@dbx/shared';
import { analyzeScratchSql, assertScratchTableName } from './scratch-guard';
import type { ScratchStatement } from './scratch-guard';
import type { Limits, TableStructure, WorkerRequest, WorkerResponse } from './scratch-worker';

export type { TableStructure } from './scratch-worker';

export type ScratchColumnType = 'text' | 'numeric' | 'timestamp' | 'boolean';

export interface ScratchManagerOptions {
  maxWorkspaces: number;
  /** Rows across all tables of one workspace. */
  maxRows: number;
  maxTables: number;
  ttlMinutes: number;
  /** Deadline of one call, measured from when it is enqueued (queue time included). */
  statementTimeoutMs: number;
  /** Rows returned by one SELECT (default: maxRows). */
  maxResultRows?: number;
  /** Approximate size of one result or dry-run snapshot; larger ones fail (default 16 MiB). */
  maxResultBytes?: number;
  /** Stored bytes across all tables of one workspace (default 64 MiB). */
  maxBytes?: number;
  /** WASM memory after which a workspace's worker is recycled (default 1 GiB). */
  maxWasmMemoryBytes?: number;
  /** Calls waiting behind the running one, per workspace; beyond it RATE_LIMITED (default 4). */
  maxQueuedPerWorkspace?: number;
  /** Rows shown on each side of a transactional dry run (default 200). */
  previewRows?: number;
  /** Background eviction period; 0 disables it (default 60 s). */
  sweepIntervalMs?: number;
  now?: () => number;
}

export const SCRATCH_DEFAULTS = {
  maxResultBytes: 16 * 1024 * 1024,
  maxBytes: 64 * 1024 * 1024,
  maxWasmMemoryBytes: 1024 * 1024 * 1024,
  maxQueuedPerWorkspace: 4,
  previewRows: 200,
  sweepIntervalMs: 60_000,
} as const;

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

export interface DdlDryRunResult {
  table: string;
  before: TableStructure | null;
  after: TableStructure | null;
}

const DDL_COMMANDS = new Set(['CREATE TABLE', 'ALTER TABLE', 'DROP TABLE']);

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
  isReady: boolean;
  pending: Map<number, Pending>;
}

interface HostConfig {
  timeoutMs: number;
  maxQueued: number;
  maxWasmMemoryBytes: number;
}

interface Job {
  op: Op;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  /** Absolute deadline (wall clock); pushed back by the job's own wait for a cold worker. */
  deadline: number;
  timer: NodeJS.Timeout | undefined;
  done: boolean;
  /** True while this job waits for its worker to start (the deadline is not enforced then). */
  starting: boolean;
}

const closedError = () =>
  new AppError('NOT_FOUND', 'The scratch workspace was closed; open a new one.');

/**
 * One worker thread with a bounded FIFO queue. Every call has a deadline that starts when it is
 * enqueued and observes its abort signal from then on. A call that expires while queued is just
 * dropped; one that expires while running takes the worker (and the workspace data) down with it.
 * Once closed, the host never starts a worker again.
 */
class WorkerHost {
  private slot: Slot | null = null;
  private closed = false;
  private readonly waiting: Job[] = [];
  private current: Job | null = null;
  private nextId = 1;

  constructor(private readonly cfg: HostConfig) {}

  run<T>(op: Op, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(closedError());
    if (signal?.aborted) {
      return Promise.reject(new AppError('QUERY_CANCELLED', 'The query was cancelled.'));
    }
    if (this.waiting.length >= this.cfg.maxQueued) {
      return Promise.reject(
        new AppError('RATE_LIMITED', 'Too many scratch statements are waiting. Try again later.'),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        op,
        resolve: resolve as (v: unknown) => void,
        reject,
        signal,
        onAbort: () => undefined,
        deadline: Date.now() + this.cfg.timeoutMs,
        timer: undefined,
        done: false,
        starting: false,
      };
      job.onAbort = () => {
        const running = job === this.current;
        this.stop(
          job,
          new AppError(
            'QUERY_CANCELLED',
            running
              ? 'The query was cancelled; the workspace was reset.'
              : 'The query was cancelled.',
          ),
        );
      };
      signal?.addEventListener('abort', job.onAbort, { once: true });
      this.arm(job);
      this.waiting.push(job);
      void this.pump();
    });
  }

  /** True while a worker thread exists for this host. */
  alive(): boolean {
    return this.slot !== null;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.waiting.splice(0)) this.settle(job, () => job.reject(closedError()));
    const current = this.current;
    if (current) this.settle(current, () => current.reject(closedError()));
    const slot = this.slot;
    if (slot) await this.reset(slot);
  }

  private arm(job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.expire(job), Math.max(0, job.deadline - Date.now()));
  }

  private expire(job: Job): void {
    // A cold start has its own timeout; the job's deadline is re-armed once the worker is ready.
    if (job.starting) return;
    const running = job === this.current;
    this.stop(
      job,
      new AppError(
        'QUERY_TIMEOUT',
        `The scratch statement exceeded ${this.cfg.timeoutMs} ms, queue time included${
          running ? '; the workspace was reset' : ''
        }.`,
      ),
    );
  }

  /** Settles a job once; returns false when it was already settled. */
  private settle(job: Job, fn: () => void): boolean {
    if (job.done) return false;
    job.done = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    fn();
    return true;
  }

  /** Timeout or abort: a queued job is dropped; the running job takes its worker down. */
  private stop(job: Job, error: AppError): void {
    if (!this.settle(job, () => job.reject(error))) return;
    const i = this.waiting.indexOf(job);
    if (i >= 0) this.waiting.splice(i, 1);
    if (job === this.current && this.slot) void this.reset(this.slot);
  }

  private async pump(): Promise<void> {
    if (this.current) return;
    for (let job = this.waiting.shift(); job; job = this.waiting.shift()) {
      const current = job;
      if (current.done) continue;
      this.current = current;
      try {
        const value = await this.dispatch(current);
        this.settle(current, () => current.resolve(value));
      } catch (err) {
        this.settle(current, () => current.reject(err));
      } finally {
        this.current = null;
      }
    }
  }

  private async dispatch(job: Job): Promise<unknown> {
    const slot = this.start();
    if (!slot.isReady) {
      const t0 = Date.now();
      job.starting = true;
      try {
        await slot.ready;
      } finally {
        job.starting = false;
      }
      if (job.done) return undefined;
      job.deadline += Date.now() - t0;
      this.arm(job);
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage({ ...job.op, id } as WorkerRequest);
    });
  }

  private start(): Slot {
    if (this.closed) throw closedError();
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
    const slot: Slot = { worker, ready, isReady: false, pending };

    const timer = setTimeout(() => {
      failStart(new AppError('INTERNAL_ERROR', 'The scratch workspace did not start.'));
      void this.reset(slot);
    }, STARTUP_TIMEOUT_MS);
    timer.unref();

    worker.on('message', (msg: WorkerResponse) => {
      if ('ready' in msg) {
        clearTimeout(timer);
        slot.isReady = true;
        markReady();
        return;
      }
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.result);
        else {
          const details = msg.error.sqlState ? { sqlState: msg.error.sqlState } : undefined;
          entry.reject(new AppError(msg.error.code, msg.error.message, details));
        }
      }
      // WASM memory never shrinks: recycle a worker that grew past the ceiling.
      if (msg.wasmBytes > this.cfg.maxWasmMemoryBytes) void this.reset(slot);
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

  /**
   * Runs a statement already analyzed with `analyzeScratchSql` (and authorized by the caller).
   * `caps` can only lower the workspace limits: `maxResultRows` truncates the returned rows, and
   * `maxWriteRows` refuses (and rolls back) a mutating statement that changes more rows.
   */
  async execStatement(
    stmt: ScratchStatement,
    signal?: AbortSignal,
    caps: { maxResultRows?: number; maxWriteRows?: number } = {},
  ): Promise<ScratchResult> {
    const limits: Limits = {
      ...this.limits,
      maxResultRows: Math.min(this.limits.maxResultRows, caps.maxResultRows ?? Infinity),
      ...(caps.maxWriteRows !== undefined ? { maxWriteRows: caps.maxWriteRows } : {}),
    };
    const res = await this.use(() =>
      this.host.run<Omit<ScratchResult, 'command'>>(
        { op: 'exec', sql: stmt.sql, mutating: stmt.mutating, limits },
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
    signal?: AbortSignal,
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
      this.host.run({ op: 'import', table, columns, rows, limits: this.limits }, signal),
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
        limits: this.limits,
      }),
    );
    return { table: target, ...res };
  }

  /** Every table with its columns (PostgreSQL types, in order) and row count. */
  describe(): Promise<TableStructure[]> {
    return this.use(() => this.host.run({ op: 'describe' }));
  }

  /**
   * BEGIN, run a CREATE / ALTER / DROP already analyzed with `analyzeScratchSql` (and authorized
   * by the caller), describe its target before and after, ROLLBACK. `null` is "no such table".
   */
  async ddlDryRun(stmt: ScratchStatement): Promise<DdlDryRunResult> {
    if (!DDL_COMMANDS.has(stmt.command) || stmt.target === null) {
      throw new AppError('VALIDATION_ERROR', 'A structure dry run needs a CREATE, ALTER or DROP.');
    }
    const target = stmt.target.toLowerCase();
    const res = await this.use(() =>
      this.host.run<Omit<DdlDryRunResult, 'table'>>({
        op: 'ddlDryRun',
        sql: stmt.sql,
        target,
        limits: this.limits,
      }),
    );
    return { table: target, ...res };
  }

  /** @internal True while this workspace has a live worker thread. */
  workerAlive(): boolean {
    return this.host.alive();
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
  private closed = false;

  constructor(private readonly opts: ScratchManagerOptions) {
    this.now = opts.now ?? Date.now;
    const every = opts.sweepIntervalMs ?? SCRATCH_DEFAULTS.sweepIntervalMs;
    this.sweeper =
      every > 0
        ? setInterval(() => {
            this.evictIdle().catch(() => undefined);
          }, every)
        : null;
    this.sweeper?.unref();
  }

  async workspace(userId: string): Promise<ScratchWorkspace> {
    if (this.closed) throw new AppError('NOT_FOUND', 'Scratch workspaces are shut down.');
    if (!userId) throw new AppError('VALIDATION_ERROR', 'A scratch workspace needs a user.');
    const existing = this.workspaces.get(userId);
    if (existing) return existing;
    if (this.workspaces.size >= this.opts.maxWorkspaces) {
      await this.evictIdle();
      // Another request for this user may have created it while eviction ran.
      const created = this.workspaces.get(userId);
      if (created) return created;
      if (this.closed) throw new AppError('NOT_FOUND', 'Scratch workspaces are shut down.');
    }
    if (this.workspaces.size >= this.opts.maxWorkspaces) {
      throw new AppError('RATE_LIMITED', 'All scratch workspaces are in use. Try again later.');
    }
    const o = this.opts;
    const ws = new ScratchWorkspace(
      new WorkerHost({
        timeoutMs: o.statementTimeoutMs,
        maxQueued: o.maxQueuedPerWorkspace ?? SCRATCH_DEFAULTS.maxQueuedPerWorkspace,
        maxWasmMemoryBytes: o.maxWasmMemoryBytes ?? SCRATCH_DEFAULTS.maxWasmMemoryBytes,
      }),
      {
        maxRows: o.maxRows,
        maxTables: o.maxTables,
        maxResultRows: o.maxResultRows ?? o.maxRows,
        maxResultBytes: o.maxResultBytes ?? SCRATCH_DEFAULTS.maxResultBytes,
        maxBytes: o.maxBytes ?? SCRATCH_DEFAULTS.maxBytes,
      },
      o.previewRows ?? SCRATCH_DEFAULTS.previewRows,
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

  /** Closes every workspace; the manager refuses new workspaces afterwards. */
  async closeAll(): Promise<void> {
    this.closed = true;
    if (this.sweeper) clearInterval(this.sweeper);
    const all = [...this.workspaces.values()];
    this.workspaces.clear();
    await Promise.all(all.map((ws) => ws.close()));
  }

  stats(): { workspaces: number } {
    return { workspaces: this.workspaces.size };
  }
}
