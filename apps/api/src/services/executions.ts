import { AppError } from '@dbx/shared';

interface Running {
  userId: string;
  controller: AbortController;
}

/** In-flight read statements, so their owner (or an admin) can cancel them. */
export class ExecutionRegistry {
  private readonly running = new Map<string, Running>();

  /** Caps the gateway traffic a single user can generate at once (on top of the global rate limit). */
  static readonly MAX_PER_USER = 3;

  start(executionId: string, userId: string): AbortController {
    if (this.running.has(executionId))
      throw new AppError('CONFLICT', 'An execution with this id is already running');
    let mine = 0;
    for (const r of this.running.values()) if (r.userId === userId) mine++;
    if (mine >= ExecutionRegistry.MAX_PER_USER)
      throw new AppError(
        'RATE_LIMITED',
        `You already have ${mine} queries running; wait for one to finish or cancel it`,
      );
    const controller = new AbortController();
    this.running.set(executionId, { userId, controller });
    return controller;
  }

  finish(executionId: string): void {
    this.running.delete(executionId);
  }

  /** Returns false when unknown or not owned (indistinguishable to the caller). */
  cancel(executionId: string, userId: string, isAdmin: boolean): boolean {
    const r = this.running.get(executionId);
    if (!r || (r.userId !== userId && !isAdmin)) return false;
    r.controller.abort(new AppError('QUERY_CANCELLED', 'The query was cancelled by the user'));
    return true;
  }

  get size(): number {
    return this.running.size;
  }

  abortAll(): void {
    for (const r of this.running.values())
      r.controller.abort(new AppError('QUERY_CANCELLED', 'The server is shutting down'));
  }
}
