import { describe, expect, it } from 'vitest';
import type { AuditEventRow } from '@dbx/database';
import { REDACTED, SNAPSHOT_MAX_STRING_CHARS, redactSnapshot } from '@dbx/shared';
import { classifyStatement } from '@dbx/sql-engine';
import { analyzeRollback, buildRollbackSql, checkRoundTrip } from './rollback';

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

const BS = String.fromCharCode(92);

/** The value the engine reads back from the first SET of a statement. */
function setValue(sql: string): unknown {
  const c = classifyStatement(sql);
  if (c.kind !== 'UPDATE' || c.stmt?.type !== 'update') throw new Error(`not an UPDATE: ${sql}`);
  return (c.stmt.set[0]!.value as { value: unknown }).value;
}

describe('literals round-trip exactly through the engine parser', () => {
  const values: Array<[string, string]> = [
    ['a backslash', `C:${BS}temp${BS}new`],
    ['a doubled backslash', `${BS}${BS}share`],
    ['backslash-n and backslash-t sequences', `x${BS}n${BS}ty${BS}r`],
    ['a trailing backslash', `back${BS}`],
    ['a lone backslash', BS],
    ['quotes mixed with backslashes', `${BS}'q${BS}'' O${BS}${BS}'Neil${BS}`],
    ['an injection attempt through a backslash', `${BS}' WHERE CODPARC > 0 OR 'a'='a`],
    ['a date as the gateway sends it', '20/10/2026 10:00:00'],
  ];
  for (const [name, value] of values) {
    it(`restores ${name} byte for byte`, () => {
      const a = analyzeRollback(executed({ before: [{ CODPARC: 1, NOMEPARC: value }] }));
      expect(a.ok).toBe(true);
      if (!a.ok) return;
      expect(setValue(a.targets[0]!.sql)).toBe(value);
      expect(a.targets[0]!.restore.NOMEPARC).toBe(value);
    });
  }

  it('a backslash in a string key still matches the WHERE exactly', () => {
    const key = `A${BS}1`;
    const a = analyzeRollback(
      executed({
        statement: "UPDATE TGFPAR SET NOMEPARC = 'x' WHERE CODPARC = 'A'",
        before: [{ CODPARC: key, NOMEPARC: 'y' }],
        after: [{ CODPARC: key, NOMEPARC: 'x' }],
      }),
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const c = classifyStatement(a.targets[0]!.sql);
    if (c.kind !== 'UPDATE' || c.stmt?.type !== 'update') throw new Error('not an UPDATE');
    expect(c.stmt.where).toEqual({
      kind: 'compare',
      op: '=',
      left: { kind: 'column', name: 'codparc' },
      right: { kind: 'literal', value: key },
    });
  });

  it('a boolean is refused: the gateway dialects have no boolean literal', () => {
    const a = analyzeRollback(executed({ before: [{ CODPARC: 1, NOMEPARC: true }] }));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/boolean/i);
  });
});

describe('checkRoundTrip', () => {
  const restore = { NOMEPARC: `a${BS}b` };
  const key = { CODPARC: 1 };

  it('accepts a statement the parser reads back as intended', () => {
    expect(
      checkRoundTrip(
        `UPDATE TGFPAR SET NOMEPARC = 'a${BS}${BS}b' WHERE (CODPARC = 1)`,
        'TGFPAR',
        restore,
        key,
      ),
    ).toBeNull();
  });

  const bad: Array<[string, string]> = [
    ['a backslash read as an escape', `UPDATE TGFPAR SET NOMEPARC = 'a${BS}b' WHERE (CODPARC = 1)`],
    ['another table', `UPDATE TGFPRO SET NOMEPARC = 'a${BS}${BS}b' WHERE (CODPARC = 1)`],
    ['another key value', `UPDATE TGFPAR SET NOMEPARC = 'a${BS}${BS}b' WHERE (CODPARC = 2)`],
    ['a key of another type', `UPDATE TGFPAR SET NOMEPARC = 'a${BS}${BS}b' WHERE (CODPARC = '1')`],
    [
      'a widened WHERE',
      `UPDATE TGFPAR SET NOMEPARC = 'a${BS}${BS}b' WHERE (CODPARC = 1) OR (1 = 1)`,
    ],
    [
      'an extra SET',
      `UPDATE TGFPAR SET NOMEPARC = 'a${BS}${BS}b', EMAIL = NULL WHERE (CODPARC = 1)`,
    ],
    ['an expression for a value', `UPDATE TGFPAR SET NOMEPARC = NOMEPARC WHERE (CODPARC = 1)`],
    ['unparseable SQL', `UPDATE TGFPAR SET NOMEPARC = 'a${BS}' WHERE (CODPARC = 1)`],
  ];
  for (const [name, sql] of bad) {
    it(`refuses ${name}`, () => {
      expect(checkRoundTrip(sql, 'TGFPAR', restore, key)).toMatch(/read back/i);
    });
  }
});

describe('clipped values', () => {
  it('a value clipped on a surrogate pair (2000 chars ending in …) is refused', () => {
    const long = `${'a'.repeat(SNAPSHOT_MAX_STRING_CHARS - 1)}😀${'b'.repeat(500)}`;
    const [row] = redactSnapshot([{ CODPARC: 1, NOMEPARC: long }]).rows as Array<{
      NOMEPARC: string;
    }>;
    expect(row!.NOMEPARC.length).toBe(SNAPSHOT_MAX_STRING_CHARS);
    const a = analyzeRollback(executed({ before: [{ CODPARC: 1, NOMEPARC: row!.NOMEPARC }] }));
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.reason).toMatch(/clipped/i);
  });

  it('a value of exactly the limit that was not clipped is still restorable', () => {
    const exact = 'a'.repeat(SNAPSHOT_MAX_STRING_CHARS);
    const [row] = redactSnapshot([{ CODPARC: 1, NOMEPARC: exact }]).rows as Array<{
      NOMEPARC: string;
    }>;
    expect(row!.NOMEPARC).toBe(exact);
    expect(analyzeRollback(executed({ before: [{ CODPARC: 1, NOMEPARC: exact }] })).ok).toBe(true);
  });
});
