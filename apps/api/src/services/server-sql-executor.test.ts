import { describe, expect, it, vi } from 'vitest';
import { AppError, isAppError } from '@dbx/shared';
import type {
  ExecuteJavaInput,
  ExecuteJavaResult,
  RemoveRecordsInput,
  RemoveRecordsResult,
  SaveInput,
  SaveResult,
} from '@dbx/sankhya-client';
import {
  DEFAULT_SERVER_SQL_ACTION,
  ServerSqlExecutor,
  extractRecordId,
  type ServerSqlClient,
} from './server-sql-executor';

/** Programmable fake of the three client calls a dispatch uses; records every request. */
function fakeClient(
  overrides: {
    save?: (input: SaveInput) => SaveResult | Promise<SaveResult>;
    executeJava?: (input: ExecuteJavaInput) => ExecuteJavaResult | Promise<ExecuteJavaResult>;
    removeRecords?: (
      input: RemoveRecordsInput,
    ) => RemoveRecordsResult | Promise<RemoveRecordsResult>;
  } = {},
) {
  const saves: SaveInput[] = [];
  const actions: ExecuteJavaInput[] = [];
  const removes: RemoveRecordsInput[] = [];
  const client: ServerSqlClient = {
    save: vi.fn((input: SaveInput) => {
      saves.push(input);
      return Promise.resolve(
        overrides.save?.(input) ?? ({ results: [['5001']] } satisfies SaveResult),
      );
    }),
    executeJava: vi.fn((input: ExecuteJavaInput) => {
      actions.push(input);
      return Promise.resolve(
        overrides.executeJava?.(input) ??
          ({ status: '1', transactionId: 'TX' } as ExecuteJavaResult),
      );
    }),
    removeRecords: vi.fn((input: RemoveRecordsInput) => {
      removes.push(input);
      return Promise.resolve(
        overrides.removeRecords?.(input) ?? ({ status: '1' } as RemoveRecordsResult),
      );
    }),
  };
  return { client, saves, actions, removes };
}

const BLOCK = "BEGIN\nEXECUTE IMMEDIATE q'[ALTER TABLE AD_X MODIFY (NOME VARCHAR2(120))]';\nEND;";

describe('extractRecordId', () => {
  it('takes the first scalar of the save result', () => {
    expect(extractRecordId([['5001']])).toBe('5001');
    expect(extractRecordId([[7]])).toBe('7');
    expect(extractRecordId([[null, '  42 ']])).toBe('42');
  });

  it('returns null when there is no scalar to use', () => {
    expect(extractRecordId([])).toBeNull();
    expect(extractRecordId([[null]])).toBeNull();
    expect(extractRecordId([['']])).toBeNull();
  });
});

describe('ServerSqlExecutor', () => {
  it('creates a dedicated record, fires the action on it, and cleans it up', async () => {
    const f = fakeClient();
    const executor = new ServerSqlExecutor({ client: f.client, now: () => 0 });
    const out = await executor.dispatch({
      category: 'DDL',
      sql: 'ALTER TABLE AD_X MODIFY (NOME VARCHAR2(120))',
      block: BLOCK,
      simulated: true,
    });

    // 1. INSERT into AD_MANIPULADADOS: the block in TEXTO, and NO pk (never overwrites a record).
    expect(f.saves).toEqual([
      {
        entityName: 'AD_MANIPULADADOS',
        fields: ['TEXTO'],
        records: [{ values: { TEXTO: BLOCK } }],
      },
    ]);
    expect(f.saves[0]!.records[0]).not.toHaveProperty('pk');
    // 2. action 98 fired against exactly the id the save returned.
    expect(f.actions).toEqual([
      { actionId: '98', entityName: 'AD_MANIPULADADOS', pk: { ID: '5001' } },
    ]);
    // 3. the same record is deleted afterwards.
    expect(f.removes).toEqual([{ entityName: 'AD_MANIPULADADOS', pks: [{ ID: '5001' }] }]);

    expect(out).toMatchObject({
      route: 'SERVER_SQL',
      simulated: true,
      category: 'DDL',
      recordId: '5001',
      status: 'EXECUTED',
      action: { status: '1', transactionId: 'TX' },
      cleanup: 'DELETED',
    });
    expect(out.cleanupError).toBeUndefined();
  });

  it('carries simulated=false through for a live connection', async () => {
    const f = fakeClient();
    const executor = new ServerSqlExecutor({ client: f.client });
    const out = await executor.dispatch({
      category: 'DELETE',
      sql: 'DELETE FROM TGFCAB WHERE NUNOTA = 1',
      block: 'BEGIN\nDELETE FROM TGFCAB WHERE NUNOTA = 1;\nEND;',
      simulated: false,
    });
    expect(out.simulated).toBe(false);
    expect(out.status).toBe('EXECUTED');
  });

  it('does not fire the action when the created record has no identifiable id (fails closed)', async () => {
    const f = fakeClient({ save: () => ({ results: [] }) });
    const executor = new ServerSqlExecutor({ client: f.client });
    const err = await executor
      .dispatch({ category: 'DDL', sql: 'DROP TABLE AD_X', block: BLOCK, simulated: true })
      .catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('SANKHYA_BAD_RESPONSE');
    expect(f.actions).toHaveLength(0);
    expect(f.removes).toHaveLength(0);
  });

  it('cleans up the record even when the action call fails, then surfaces the error', async () => {
    const f = fakeClient({
      executeJava: () => {
        throw new AppError('WRITE_OUTCOME_UNKNOWN', 'The gateway did not confirm.');
      },
    });
    const executor = new ServerSqlExecutor({ client: f.client });
    const err = await executor
      .dispatch({
        category: 'DML_RAW',
        sql: 'MERGE INTO A USING B ON (1=1)',
        block: BLOCK,
        simulated: true,
      })
      .catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('WRITE_OUTCOME_UNKNOWN');
    // The record it created was still cleaned up.
    expect(f.removes).toEqual([{ entityName: 'AD_MANIPULADADOS', pks: [{ ID: '5001' }] }]);
  });

  it('reports an orphaned record when cleanup fails, without failing the operation', async () => {
    const warn = vi.fn();
    const f = fakeClient({
      removeRecords: () => {
        throw new AppError('SANKHYA_UNAVAILABLE', 'gateway down');
      },
    });
    const executor = new ServerSqlExecutor({ client: f.client, logger: { error: warn } });
    const out = await executor.dispatch({
      category: 'DDL',
      sql: 'ALTER TABLE AD_X ADD (C NUMBER)',
      block: BLOCK,
      simulated: true,
    });
    expect(out.status).toBe('EXECUTED');
    expect(out.cleanup).toBe('ORPHANED');
    expect(out.cleanupError).toBe('SANKHYA_UNAVAILABLE');
    expect(warn).toHaveBeenCalledOnce();
  });

  it('marks the dispatch FAILED when the action envelope is not successful', async () => {
    const f = fakeClient({ executeJava: () => ({ status: '0', statusMessage: 'erro' }) });
    const executor = new ServerSqlExecutor({ client: f.client });
    const out = await executor.dispatch({
      category: 'DCL',
      sql: 'GRANT SELECT ON AD_X TO ROLE_X',
      block: BLOCK,
      simulated: true,
    });
    expect(out.status).toBe('FAILED');
    expect(out.action).toMatchObject({ status: '0', statusMessage: 'erro' });
    // Even a failed action's record is cleaned up.
    expect(f.removes).toHaveLength(1);
  });

  it('refuses an UNSUPPORTED category without touching the gateway', async () => {
    const f = fakeClient();
    const executor = new ServerSqlExecutor({ client: f.client });
    const err = await executor
      .dispatch({ category: 'UNSUPPORTED', sql: 'SELECT 1', block: '', simulated: true })
      .catch((e: unknown) => e);
    expect(isAppError(err) && err.code).toBe('SERVER_SQL_UNSUPPORTED');
    expect(f.saves).toHaveLength(0);
  });

  it('exposes the probed action contract as the default', () => {
    expect(DEFAULT_SERVER_SQL_ACTION).toEqual({
      entityName: 'AD_MANIPULADADOS',
      actionId: '98',
      textField: 'TEXTO',
      keyField: 'ID',
    });
  });
});
