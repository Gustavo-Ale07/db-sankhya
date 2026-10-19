import type { QueryResult } from '../api/types';

export type RunState =
  | { status: 'idle' }
  | { status: 'running'; sql: string; executionId: string; startedAt: number }
  | { status: 'result'; sql: string; result: QueryResult }
  | { status: 'error'; sql: string; error: unknown };
