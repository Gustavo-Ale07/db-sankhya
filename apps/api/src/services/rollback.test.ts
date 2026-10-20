import { describe, expect, it } from 'vitest';
import type { AuditEventRow } from '@dbx/database';
import { REDACTED, SNAPSHOT_MAX_STRING_CHARS } from '@dbx/shared';
import { classifyStatement } from '@dbx/sql-engine';
import { analyzeRollback, buildRollbackSql } from './rollback';

type Row = Record<string, unknown>;

/** A PLAN_EXECUTED row as MutationService.execute writes it for a verified UPDATE. */
function executed(
  over: Partial<AuditEventRow> & {
    before?: Row[];
    after?: Row[];
    keys?: Row[];
    verify?: string;
    operation?: string;
  } = {},
): AuditEventRow {
  const before = over.before ?? [{ CODPARC: 1, NOMEPARC: "D'Avila" }];
  const after = over.after ?? [{ CODPARC: 1, NOMEPARC: 'Novo nome' }];
  const keys = over.keys ?? before.map((b) => ({ CODPARC: b.CODPARC }));
  const { before: _b, after: _a, keys: _k, verify: _v, operation: _o, ...rest } = over;
  return {
    id: '00000000-0000-4000-8000-000000000001',
    createdAt: new Date('2026-10-20T10:00:00Z'),
    userId: null,
    userEmail: 'user@example.com',
    ip: null,
    requestId: null,
    action: 'PLAN_EXECUTED',
    operation: null,
    resource: null,
    statement: "UPDATE TGFPAR SET NOMEPARC = 'Novo nome' WHERE CODPARC = 1",
    targetIds: null,
    before: null,
    after: null,
    gatewayCalls: null,
    status: 'success',
    durationMs: 10,
    errorCode: null,
    errorMessage: null,
    details: {
      operation: over.operation ?? 'UPDATE',
      resource: 'TGFPAR',
      affectedRows: keys.length,
      report: {
        status: 'success',
        verification: over.verify ?? 'VERIFIED',
        steps: keys.map((key) => ({ key, outcome: 'ok', verified: true })),
      },
    },
    connectionId: 'env',
    environment: 'HOMOLOGATION',
    planId: '00000000-0000-4000-8000-000000000002',
    planHash: 'h',
    capability: 'DATA.UPDATE',
    verification: null,
    approvalId: null,
    policyDecision: null,
    snapshot: {
      before: { rows: before, totalRows: before.length, truncated: false, truncatedBytes: 0 },
      after: { rows: after, totalRows: after.length, truncated: false, truncatedBytes: 0 },
    },
    ...rest,
  } as AuditEventRow;
}

describe('buildRollbackSql', () => {
  it('a verified UPDATE: SET the before values WHERE the key, values escaped', () => {
    const sql = buildRollbackSql(executed());
    expect(sql).toBe("UPDATE TGFPAR SET NOMEPARC = 'D''Avila' WHERE (CODPARC = 1)");
  });

  it('round-trips through the parser as a keyed UPDATE of the same table', () => {
    const sql = buildRollbackSql(
      executed({
        statement: 'UPDATE TGFPAR SET NOMEPARC = NOMEPARC, LIMCRED = LIMCRED * 2 WHERE CODPARC = 7',
        before: [{ CODPARC: 7, NOMEPARC: "x' OR '1'='1", LIMCRED: -12.5 }],
        after: [{ CODPARC: 7, NOMEPARC: "x' OR '1'='1", LIMCRED: -25 }],
      }),
    )!;
    const c = classifyStatement(sql);
    expect(c.kind).toBe('UPDATE');
    if (c.kind !== 'UPDATE') return;
    expect(c.table).toBe('TGFPAR');
    expect(c.hasWhere).toBe(true);
    expect(c.stmt?.type).toBe('update');
    if (c.stmt?.type !== 'update') return;
    expect(c.stmt.set.map((s) => s.column.toUpperCase())).toEqual(['NOMEPARC', 'LIMCRED']);
    expect(c.stmt.set[0]!.value).toEqual({ kind: 'literal', value: "x' OR '1'='1" });
  });

  it('one statement per target, joined for display; NULL restores NULL', () => {
    const sql = buildRollbackSql(
      executed({
        statement: "UPDATE TGFPAR SET EMAIL = 'a@example.com' WHERE CODPARC IN (1, 2)",
        before: [
          { CODPARC: 1, EMAIL: null },
          { CODPARC: 2, EMAIL: 'b@example.com' },
        ],
        after: [
          { CODPARC: 1, EMAIL: 'a@example.com' },
          { CODPARC: 2, EMAIL: 'a@example.com' },
        ],
      }),
    );
    expect(sql).toBe(
      'UPDATE TGFPAR SET EMAIL = NULL WHERE (CODPARC = 1);\n' +
        "UPDATE TGFPAR SET EMAIL = 'b@example.com' WHERE (CODPARC = 2)",
    );
  });

  it('a composite key gives every key column in the WHERE', () => {
    const a = analyzeRollback(
      executed({
        statement: 'UPDATE TGFITE SET QTDNEG = 3 WHERE NUNOTA = 10 AND SEQUENCIA = 1',
        before: [{ NUNOTA: 10, SEQUENCIA: 1, QTDNEG: 2 }],
        after: [{ NUNOTA: 10, SEQUENCIA: 1, QTDNEG: 3 }],
        keys: [{ NUNOTA: 10, SEQUENCIA: 1 }],
      }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.targets[0]!.sql).toBe(
      'UPDATE TGFITE SET QTDNEG = 2 WHERE ((NUNOTA = 10) AND (SEQUENCIA = 1))',
    );
    expect(a.targets[0]!.expectedCurrent).toEqual({ QTDNEG: 3 });
    expect(a.entity).toBe('TGFITE');
    expect(a.connectionId).toBe('env');
  });

  const refusals: Array<[string, AuditEventRow, RegExp]> = [
    ['not a PLAN_EXECUTED event', executed({ action: 'PLAN_CREATED' }), /executed/i],
    ['an INSERT', executed({ operation: 'INSERT' }), /UPDATE/],
    ['a DELETE', executed({ operation: 'DELETE' }), /UPDATE/],
    ['an unverified result', executed({ verify: 'UNVERIFIED' }), /VERIFIED/],
    ['a partially verified result', executed({ verify: 'PARTIALLY_VERIFIED' }), /VERIFIED/],
    ['a failed run', executed({ status: 'partial' }), /succe/i],
    [
      'auditSnapshots=false (no snapshot)',
      executed({
        snapshot: null,
        details: {
          operation: 'UPDATE',
          snapshotsDisabled: true,
          report: { status: 'success', verification: 'VERIFIED', steps: [] },
        },
      }),
      /snapshot/i,
    ],
    [
      'a truncated snapshot',
      executed({
        snapshot: {
          before: { rows: [], totalRows: 60, truncated: true, truncatedBytes: 0 },
          after: { rows: [], totalRows: 60, truncated: true, truncatedBytes: 0 },
        },
      }),
      /incomplete/i,
    ],
    ['a redacted value', executed({ before: [{ CODPARC: 1, NOMEPARC: REDACTED }] }), /redacted/i],
    [
      'a value with a scrubbed fragment',
      executed({ before: [{ CODPARC: 1, NOMEPARC: `x ${REDACTED} y` }] }),
      /redacted/i,
    ],
    [
      'a clipped value',
      executed({
        before: [{ CODPARC: 1, NOMEPARC: `${'a'.repeat(SNAPSHOT_MAX_STRING_CHARS)}…` }],
      }),
      /clipped/i,
    ],
    ['a scratch write', executed({ connectionId: 'scratch' }), /scratch/i],
    ['a key that does not match the row', executed({ keys: [{ CODPARC: 99 }] }), /match/i],
    [
      'a number the parser cannot read back',
      executed({ before: [{ CODPARC: 1, NOMEPARC: 1e21 }] }),
      /value/i,
    ],
    ['an unparseable statement', executed({ statement: 'UPDATE TGFPAR SET' }), /statement/i],
    [
      'a column name that is not an identifier',
      executed({
        statement: 'UPDATE TGFPAR SET "NOME PARC" = 1 WHERE CODPARC = 1',
        before: [{ CODPARC: 1, 'NOME PARC': 2 }],
        after: [{ CODPARC: 1, 'NOME PARC': 1 }],
      }),
      /./,
    ],
  ];

  for (const [name, event, reason] of refusals) {
    it(`null for ${name}`, () => {
      expect(buildRollbackSql(event)).toBeNull();
      const a = analyzeRollback(event);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.reason).toMatch(reason);
    });
  }
});
