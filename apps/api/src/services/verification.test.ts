import { describe, expect, it } from 'vitest';
import { SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_ROWS, SNAPSHOT_MAX_STRING_CHARS } from '@dbx/shared';
import { labelOf, reportForAudit, verifyByKey } from './verification';
import type { ExecutionReport, ExecutionStep } from './verification';

type LoadRecords = Parameters<typeof verifyByKey>[0]['loadRecords'];

/** A gateway that answers every read with `records` (one page). */
const reading = (records: Array<Record<string, unknown>>): { loadRecords: LoadRecords } => ({
  loadRecords: (() => Promise.resolve({ records, hasMore: false })) as unknown as LoadRecords,
});

const failing: { loadRecords: LoadRecords } = {
  loadRecords: (() => Promise.reject(new Error('read failed'))) as unknown as LoadRecords,
};

const input = (
  targets: Array<{ key: Record<string, unknown>; expected: Record<string, unknown> }>,
) => ({
  entityName: 'Parceiro',
  pk: ['CODPARC'],
  targets,
});

describe('verifyByKey', () => {
  it('an equal read-back is verified and returns the observed values', async () => {
    const out = await verifyByKey(
      reading([{ CODPARC: '1', NOMEPARC: 'Novo nome' }]),
      input([{ key: { CODPARC: 1 }, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out).toEqual([{ verified: true, observed: { NOMEPARC: 'Novo nome' } }]);
  });

  it('a divergent read-back is not verified and reports the value actually read', async () => {
    const out = await verifyByKey(
      reading([{ CODPARC: '1', NOMEPARC: 'Antigo' }]),
      input([{ key: { CODPARC: 1 }, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out).toEqual([{ verified: false, observed: { NOMEPARC: 'Antigo' } }]);
  });

  it('observed holds only the expected keys, even when the read returns more columns', async () => {
    const out = await verifyByKey(
      reading([{ CODPARC: '1', NOMEPARC: 'Novo nome', EMAIL: 'x@example.com', ATIVO: 'S' }]),
      input([{ key: { CODPARC: 1 }, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out[0]!.observed).toEqual({ NOMEPARC: 'Novo nome' });
  });

  it('an empty gateway cell is observed as null', async () => {
    const out = await verifyByKey(
      reading([{ CODPARC: '1', EMAIL: {} }]),
      input([{ key: { CODPARC: 1 }, expected: { EMAIL: null } }]),
    );
    expect(out).toEqual([{ verified: true, observed: { EMAIL: null } }]);
  });

  it('a missing row is not verified and has no observed values', async () => {
    const out = await verifyByKey(
      reading([]),
      input([{ key: { CODPARC: 1 }, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out).toEqual([{ verified: false }]);
  });

  it('a failed read is neither verified nor observed', async () => {
    const out = await verifyByKey(
      failing,
      input([{ key: { CODPARC: 1 }, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out).toEqual([{}]);
  });

  it('a target without a complete key is never read', async () => {
    const out = await verifyByKey(
      reading([{ CODPARC: '1', NOMEPARC: 'Novo nome' }]),
      input([{ key: {}, expected: { NOMEPARC: 'Novo nome' } }]),
    );
    expect(out).toEqual([{}]);
  });

  it('matches several targets by key, each with its own observed row', async () => {
    const out = await verifyByKey(
      reading([
        { CODPARC: '2', NOMEPARC: 'Outro' },
        { CODPARC: '1', NOMEPARC: 'Lote' },
      ]),
      input([
        { key: { CODPARC: 1 }, expected: { NOMEPARC: 'Lote' } },
        { key: { CODPARC: 2 }, expected: { NOMEPARC: 'Lote' } },
      ]),
    );
    expect(out).toEqual([
      { verified: true, observed: { NOMEPARC: 'Lote' } },
      { verified: false, observed: { NOMEPARC: 'Outro' } },
    ]);
  });
});

describe('labelOf', () => {
  const step = (s: Partial<ExecutionStep>): ExecutionStep => ({ key: {}, outcome: 'ok', ...s });

  it('keeps the labels: VERIFIED, FAILED, PARTIALLY_VERIFIED, UNVERIFIED', () => {
    expect(labelOf([step({ verified: true })])).toBe('VERIFIED');
    expect(labelOf([step({ verified: true }), step({ verified: false })])).toBe('FAILED');
    expect(labelOf([step({ verified: true }), step({})])).toBe('PARTIALLY_VERIFIED');
    expect(labelOf([step({})])).toBe('UNVERIFIED');
  });
});

describe('reportForAudit', () => {
  const report = (steps: ExecutionStep[]): ExecutionReport => ({
    status: 'success',
    verification: 'VERIFIED',
    steps,
  });
  const valued = (i: number, text: string): ExecutionStep => ({
    key: { CODPARC: i },
    outcome: 'ok',
    verified: true,
    before: { NOMEPARC: `old ${text}` },
    expected: { NOMEPARC: text },
    observed: { NOMEPARC: text },
  });

  it('a small report is stored as is', () => {
    const live = report([valued(1, 'Novo nome')]);
    expect(reportForAudit(live, { snapshots: true })).toEqual(live);
  });

  it('auditSnapshots=false: no row value is stored, keys and labels are', () => {
    const stored = reportForAudit(report([valued(1, 'Novo nome')]), { snapshots: false });
    expect(stored.steps).toEqual([{ key: { CODPARC: 1 }, outcome: 'ok', verified: true }]);
    expect(stored.verification).toBe('VERIFIED');
  });

  it('clips long strings in the stored copy only, and marks the values truncated', () => {
    const long = 'x'.repeat(SNAPSHOT_MAX_STRING_CHARS + 10);
    const live = report([valued(1, long)]);
    const stored = reportForAudit(live, { snapshots: true });
    expect(stored.valuesTruncated).toBe(true);
    const observed = stored.steps[0]!.observed!.NOMEPARC as string;
    expect(observed.length).toBe(SNAPSHOT_MAX_STRING_CHARS + 1);
    expect(observed.endsWith('…')).toBe(true);
    // The live report is never touched.
    expect(live.steps[0]!.observed!.NOMEPARC).toBe(long);
    expect(live).not.toHaveProperty('valuesTruncated');
  });

  it(`keeps values for at most ${SNAPSHOT_MAX_ROWS} steps; later steps keep only key and outcome`, () => {
    const steps = Array.from({ length: SNAPSHOT_MAX_ROWS + 5 }, (_, i) => valued(i + 1, 'v'));
    const stored = reportForAudit(report(steps), { snapshots: true });
    expect(stored.valuesTruncated).toBe(true);
    expect(stored.steps).toHaveLength(SNAPSHOT_MAX_ROWS + 5);
    expect(stored.steps[SNAPSHOT_MAX_ROWS - 1]).toHaveProperty('observed');
    expect(stored.steps[SNAPSHOT_MAX_ROWS]).toEqual({
      key: { CODPARC: SNAPSHOT_MAX_ROWS + 1 },
      outcome: 'ok',
      verified: true,
    });
    expect(steps[SNAPSHOT_MAX_ROWS]).toHaveProperty('observed');
  });

  it(`keeps the stored values within ${SNAPSHOT_MAX_BYTES} bytes`, () => {
    const wide = 'é'.repeat(SNAPSHOT_MAX_STRING_CHARS - 10);
    const steps = Array.from({ length: SNAPSHOT_MAX_ROWS }, (_, i) => valued(i + 1, wide));
    const stored = reportForAudit(report(steps), { snapshots: true });
    expect(stored.valuesTruncated).toBe(true);
    const kept = stored.steps.filter((s) => s.observed !== undefined);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(SNAPSHOT_MAX_ROWS);
    const bytes = Buffer.byteLength(
      JSON.stringify(
        kept.map(({ before, expected, observed }) => ({ before, expected, observed })),
      ),
    );
    expect(bytes).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    // Once the budget is spent, no later step keeps values (no gaps).
    const firstDropped = stored.steps.findIndex((s) => s.observed === undefined);
    expect(stored.steps.slice(firstDropped).every((s) => s.observed === undefined)).toBe(true);
  });
});
