/**
 * Write-side helpers that do not depend on any ERP integration: the environment
 * policy check and the stable hashes used to bind a confirmation to exactly the
 * statement and the targets that were previewed.
 *
 * Mutations themselves are not available yet; the API fails closed.
 */
import { createHash } from 'node:crypto';
import { AppError } from '@dbx/shared';
import type { WriteStatement } from './ast';
import type { Value } from './values';

export type WriteKind = 'insert' | 'update' | 'delete';

export interface WritePolicy {
  readOnly: boolean;
  allowInsert: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
}

export type RecordValues = Record<string, Value>;

export interface WriteTarget {
  /** Identifying columns of the record (empty for INSERT). */
  key: RecordValues;
  before: RecordValues | null;
  after: RecordValues;
  /** Business payload sent to the gateway (never credentials). */
  param: Record<string, unknown>;
}

const DISABLED = {
  insert: 'INSERT_DISABLED',
  update: 'UPDATE_DISABLED',
  delete: 'DELETE_DISABLED',
} as const;

/** Environment policy. Checked after the role check (done by the caller) and before anything else. */
export function assertWriteEnabled(kind: WriteKind, policy: WritePolicy): void {
  if (policy.readOnly) {
    throw new AppError('READ_ONLY_MODE', 'The server runs in read-only mode. Writes are disabled.');
  }
  const allowed =
    kind === 'insert'
      ? policy.allowInsert
      : kind === 'update'
        ? policy.allowUpdate
        : policy.allowDelete;
  if (!allowed)
    throw new AppError(DISABLED[kind], `${kind.toUpperCase()} is disabled on this server.`);
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Stable hash of the statement itself (formatting-independent). */
export function statementHash(stmt: WriteStatement): string {
  return sha256(stmt);
}

/** Order-independent hash of the previewed targets. */
export function targetsHashOf(kind: WriteKind, targets: WriteTarget[]): string {
  const parts = targets
    .map((t) => JSON.stringify(kind === 'insert' ? t.param : [t.key, t.before, t.param]))
    .sort();
  return sha256(parts);
}
