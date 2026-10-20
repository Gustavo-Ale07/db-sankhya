import { describe, expect, it } from 'vitest';
import { labelOf, verifyByKey } from './verification';
import type { ExecutionStep } from './verification';

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
