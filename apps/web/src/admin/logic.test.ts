import { describe, expect, it } from 'vitest';
import {
  EMPTY_POLICY,
  describeSecurity,
  formFromRule,
  parseLimit,
  parseList,
  policyPayload,
} from './logic';

describe('parseList', () => {
  it('splits on commas and newlines, trims and dedupes', () => {
    expect(parseList(' TGFPRO, TGFPAR\nTGFPRO ,, ')).toEqual(['TGFPRO', 'TGFPAR']);
    expect(parseList('')).toEqual([]);
  });
});

describe('parseLimit', () => {
  it('accepts blank and positive integers only', () => {
    expect(parseLimit('')).toBeUndefined();
    expect(parseLimit(' 25 ')).toBe(25);
    expect(parseLimit('0')).toBe('invalid');
    expect(parseLimit('1.5')).toBe('invalid');
    expect(parseLimit('-3')).toBe('invalid');
    expect(parseLimit('abc')).toBe('invalid');
  });
});

describe('policyPayload', () => {
  it('builds a body and drops unset limits', () => {
    const { body, problems } = policyPayload({
      ...EMPTY_POLICY,
      name: ' Limite ',
      maxWriteRows: '10',
      requireApproval: true,
      entities: 'TGFPRO, TGFPAR',
    });
    expect(problems).toEqual([]);
    expect(body).toMatchObject({
      name: 'Limite',
      subjectId: null,
      entities: ['TGFPRO', 'TGFPAR'],
      limits: { maxWriteRows: 10, requireApproval: true },
    });
    expect(body!.limits).not.toHaveProperty('maxReadRows');
  });

  it('reports form-level problems', () => {
    const r = policyPayload({ ...EMPTY_POLICY, subjectType: 'group', maxReadRows: 'x' });
    expect(r.body).toBeUndefined();
    expect(r.problems).toHaveLength(3);
  });

  it('round-trips a stored rule through the form', () => {
    const form = formFromRule({
      id: 'p1',
      name: 'R',
      effect: 'DENY',
      subjectType: 'user',
      subjectId: 'u1',
      environments: ['PRODUCTION'],
      connectionIds: [],
      actions: ['DATA.UPDATE'],
      entities: ['TGFPRO'],
      columns: [],
      limits: { maxReadRows: 5, requireWhere: true },
      overrideWhereRequired: false,
      enabled: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(policyPayload(form).body).toMatchObject({
      effect: 'DENY',
      subjectId: 'u1',
      environments: ['PRODUCTION'],
      limits: { maxReadRows: 5, requireWhere: true },
      enabled: false,
    });
  });
});

describe('describeSecurity', () => {
  it('explains that env=false blocks enabling', () => {
    const v = describeSecurity({ env: false, runtime: true, effective: false });
    expect(v.canEnable).toBe(false);
    expect(v.tone).toBe('danger');
    expect(v.note).toContain('não habilita nada');
  });
  it('flags the emergency switch', () => {
    const v = describeSecurity({ env: true, runtime: false, effective: false });
    expect(v.canEnable).toBe(true);
    expect(v.tone).toBe('warn');
  });
  it('reports writes allowed', () => {
    expect(describeSecurity({ env: true, runtime: true, effective: true }).tone).toBe('ok');
  });
});
