/**
 * Server-side ("Executa Banco") dispatch lifecycle.
 *
 * This is the REAL integration point with the client's existing server-side routine: it does not
 * reimplement the routine, it drives it through the gateway exactly as the Sankhya UI's "Executa
 * Banco" action button does. One dispatch:
 *
 *   1. CREATE a dedicated AD_MANIPULADADOS record whose TEXTO column holds the PL/SQL block to run
 *      (always an INSERT — never a pk — so it can never overwrite an existing record such as the
 *      consultancy's ID 46).
 *   2. FIRE ActionButtonsSP.executeJava (action 98) against that one record: the server-side
 *      DBScript routine runs the block.
 *   3. CLEAN UP the dedicated record (best-effort: a failed delete leaves an orphan row, it never
 *      masks the real outcome of the action).
 *
 * The routing decision (which statements come here), the switches/environment gate, the RBAC
 * permission and the policy engine are all enforced by the caller BEFORE a dispatch is built; the
 * wrapped block is produced by `wrapServerSql` in @dbx/sql-engine. This module only performs the
 * lifecycle and reports, truthfully, what the gateway did.
 *
 * `simulated` is carried end to end so a mock-connection run can never be read as a real database
 * change: the executor behaves identically either way (the mock transport answers the same calls),
 * but every result and audit record states which it was.
 */
import { AppError, isAppError } from '@dbx/shared';
import type { ServerSqlCategory } from '@dbx/sql-engine';
import type { SankhyaClient } from '@dbx/sankhya-client';

/** The minimal client surface a dispatch needs; keeps the executor unit-testable with a fake. */
export type ServerSqlClient = Pick<SankhyaClient, 'save' | 'executeJava' | 'removeRecords'>;

/**
 * Fixed contract of the "Executa Banco" action on the test base (see docs/server-sql.md):
 * action id 98 "Executar Objeto", bound to AD_MANIPULADADOS, whose TEXTO (CLOB) carries the block
 * and whose ID is the key the action runs against.
 */
export interface ServerSqlActionConfig {
  entityName: string;
  actionId: string;
  textField: string;
  keyField: string;
}

export const DEFAULT_SERVER_SQL_ACTION: ServerSqlActionConfig = {
  entityName: 'AD_MANIPULADADOS',
  actionId: '98',
  textField: 'TEXTO',
  keyField: 'ID',
};

export interface ServerSqlDispatchInput {
  /** Server-side category of the statement; UNSUPPORTED never reaches here. */
  category: ServerSqlCategory;
  /** The raw statement, kept verbatim for the audit — never the wrapped block. */
  sql: string;
  /** The PL/SQL block (from `wrapServerSql`) stored in the dedicated record's TEXTO. */
  block: string;
  /** The connection runs on the mock gateway: this dispatch is a simulation, not a real change. */
  simulated: boolean;
  signal?: AbortSignal;
}

export type ServerSqlDispatchStatus = 'EXECUTED' | 'FAILED';
export type ServerSqlCleanup = 'DELETED' | 'ORPHANED';

/** Truthful record of one dispatch: what ran, where, and what became of the dedicated record. */
export interface ServerSqlDispatch {
  route: 'SERVER_SQL';
  simulated: boolean;
  category: ServerSqlCategory;
  /** The dedicated record this dispatch created and controlled. */
  recordId: string;
  status: ServerSqlDispatchStatus;
  action: {
    /** Raw envelope status: "1" success, "0"/other not successful. */
    status: string;
    statusMessage?: string;
    transactionId?: string;
  };
  cleanup: ServerSqlCleanup;
  cleanupError?: string;
  durationMs: number;
}

export interface ServerSqlExecutorDeps {
  client: ServerSqlClient;
  config?: ServerSqlActionConfig;
  now?: () => number;
  logger?: { error(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Pulls the new record's key out of a DatasetSP.save result. An insert answers the generated pk
 * in `results`; the exact shape is gateway-defined, so this takes the first scalar it finds and
 * refuses (fails closed) when it finds none — the action must never fire against an unknown record.
 */
export function extractRecordId(results: unknown[][]): string | null {
  for (const row of results) {
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (typeof cell === 'string' && cell.trim() !== '') return cell.trim();
      if (typeof cell === 'number' && Number.isFinite(cell)) return String(cell);
    }
  }
  return null;
}

export class ServerSqlExecutor {
  private readonly config: ServerSqlActionConfig;
  private readonly now: () => number;

  constructor(private readonly deps: ServerSqlExecutorDeps) {
    this.config = deps.config ?? DEFAULT_SERVER_SQL_ACTION;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Runs one server-side dispatch. Resolves with a truthful {@link ServerSqlDispatch}. Rejects
   * (after a best-effort cleanup of any record it created) when the create or the action call
   * fails: an action that was sent but not confirmed surfaces as WRITE_OUTCOME_UNKNOWN from the
   * client and is never retried here — the caller records the operation as unconfirmed.
   */
  async dispatch(input: ServerSqlDispatchInput): Promise<ServerSqlDispatch> {
    if (input.category === 'UNSUPPORTED') {
      throw new AppError('SERVER_SQL_UNSUPPORTED', 'This statement has no server-side route.');
    }
    const started = this.now();
    const { entityName, actionId, textField, keyField } = this.config;
    const { signal } = input;

    // 1. CREATE the dedicated record (always an INSERT: no pk, so no existing record is touched).
    const saved = await this.deps.client.save(
      {
        entityName,
        fields: [textField],
        records: [{ values: { [textField]: input.block } }],
      },
      signal,
    );
    const recordId = extractRecordId(saved.results);
    if (recordId === null) {
      // We created a record we cannot identify: do not fire the action against an unknown key.
      throw new AppError(
        'SANKHYA_BAD_RESPONSE',
        'The gateway did not return the id of the dedicated record; the action was not fired.',
        { entityName },
      );
    }

    // 2. FIRE the server-side action against that one record.
    let action: ServerSqlDispatch['action'];
    try {
      const res = await this.deps.client.executeJava(
        { actionId, entityName, pk: { [keyField]: recordId } },
        signal,
      );
      action = { status: res.status };
      if (res.statusMessage !== undefined) action.statusMessage = res.statusMessage;
      if (res.transactionId !== undefined) action.transactionId = res.transactionId;
    } catch (err) {
      // The action may or may not have run: clean up the record we control, then surface the error.
      await this.cleanup(recordId, signal);
      throw err;
    }

    // 3. CLEAN UP — best-effort; an orphaned record never changes the operation's outcome.
    const cleanup = await this.cleanup(recordId, signal);

    const dispatch: ServerSqlDispatch = {
      route: 'SERVER_SQL',
      simulated: input.simulated,
      category: input.category,
      recordId,
      status: action.status === '1' ? 'EXECUTED' : 'FAILED',
      action,
      cleanup: cleanup.ok ? 'DELETED' : 'ORPHANED',
      durationMs: this.now() - started,
    };
    if (!cleanup.ok) dispatch.cleanupError = cleanup.code;
    return dispatch;
  }

  /** Deletes the dedicated record. Never throws: cleanup is housekeeping, not the operation. */
  private async cleanup(
    recordId: string,
    signal: AbortSignal | undefined,
  ): Promise<{ ok: true } | { ok: false; code: string }> {
    const { entityName, keyField } = this.config;
    try {
      await this.deps.client.removeRecords({ entityName, pks: [{ [keyField]: recordId }] }, signal);
      return { ok: true };
    } catch (err) {
      const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
      this.deps.logger?.error(
        { entityName, recordId, errorCode: code },
        'The dedicated server-side record could not be cleaned up (orphaned)',
      );
      return { ok: false, code };
    }
  }
}
