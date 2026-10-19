import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type Permission } from './permissions';
import {
  DEFAULT_LIMITS,
  evaluatePolicy,
  policyVersion,
  sha256HexUtf8,
  type PolicyRequest,
  type PolicyRule,
} from './policy';

const ALL = new Set<Permission>(PERMISSIONS);
const ADMIN = new Set<Permission>(SYSTEM_ROLE_PERMISSIONS.ADMIN);

function req(over: Partial<PolicyRequest> = {}): PolicyRequest {
  return {
    userId: 'u1',
    groupIds: ['g1'],
    action: 'QUERY.SELECT',
    environment: 'HOMOLOGATION',
    connectionId: 'c1',
    entities: ['TGFPAR'],
    columns: [],
    hasWhere: true,
    ...over,
  };
}

function rule(over: Partial<PolicyRule> & Pick<PolicyRule, 'id'>): PolicyRule {
  return {
    name: over.id,
    effect: 'ALLOW',
    subjectType: 'everyone',
    subjectId: null,
    environments: [],
    connectionIds: [],
    actions: ['*'],
    entities: [],
    columns: [],
    limits: {},
    overrideWhereRequired: false,
    enabled: true,
    ...over,
  };
}

const update = (over: Partial<PolicyRequest> = {}) =>
  req({ action: 'DATA.UPDATE', columns: [{ table: 'TGFPAR', name: 'NOMEPARC' }], ...over });
const allowUpdate = rule({ id: 'allow-upd', actions: ['DATA.UPDATE'], entities: ['TGFPAR'] });

describe('sha256HexUtf8', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['ação ✓ 😀', '6864d8918e9570ee20695604ab50077fdc25e5f8edbfd7a79a50859fd16c4e54'],
    ['a'.repeat(1000), '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'],
  ])('matches the reference digest for %#', (input, digest) => {
    expect(sha256HexUtf8(input)).toBe(digest);
  });
});

interface Case {
  name: string;
  request: PolicyRequest;
  rules: PolicyRule[];
  permissions?: Set<Permission>;
  effect: 'ALLOW' | 'DENY';
  reason?: RegExp;
}

const cases: Case[] = [
  {
    name: 'missing permission denies',
    request: req(),
    rules: [],
    permissions: new Set(),
    effect: 'DENY',
    reason: /permission missing/,
  },
  {
    name: 'SELECT is allowed by permission alone',
    request: req(),
    rules: [],
    effect: 'ALLOW',
  },
  {
    name: 'TEMP.* is allowed by permission alone',
    request: req({ action: 'TEMP.CREATE', entities: [] }),
    rules: [],
    effect: 'ALLOW',
  },
  {
    name: 'DENY on a group beats ALLOW on the user',
    request: update(),
    rules: [
      rule({ ...allowUpdate, subjectType: 'user', subjectId: 'u1' }),
      rule({ id: 'deny-g1', effect: 'DENY', subjectType: 'group', subjectId: 'g1' }),
    ],
    effect: 'DENY',
    reason: /deny-g1/,
  },
  {
    name: 'a DENY for another group does not apply',
    request: update(),
    rules: [
      allowUpdate,
      rule({ id: 'deny-g2', effect: 'DENY', subjectType: 'group', subjectId: 'g2' }),
    ],
    effect: 'ALLOW',
  },
  {
    name: 'a DENY for another user does not apply',
    request: update(),
    rules: [
      allowUpdate,
      rule({ id: 'deny-u2', effect: 'DENY', subjectType: 'user', subjectId: 'u2' }),
    ],
    effect: 'ALLOW',
  },
  {
    name: 'column DENY on TGFPAR.EMAIL denies SELECT EMAIL',
    request: req({ columns: [{ table: 'TGFPAR', name: 'EMAIL' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
  },
  {
    name: 'column DENY on TGFPAR.EMAIL allows SELECT NOMEPARC',
    request: req({ columns: [{ table: 'TGFPAR', name: 'NOMEPARC' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'ALLOW',
  },
  {
    name: 'column matching is case-insensitive',
    request: req({ columns: [{ table: 'tgfpar', name: 'email' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
  },
  {
    name: 'a qualified column DENY does not hit the same column of another table',
    request: req({ entities: ['TSIUSU'], columns: [{ table: 'TSIUSU', name: 'EMAIL' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'ALLOW',
  },
  {
    name: 'a bare column DENY hits the column on any table',
    request: req({ entities: ['TSIUSU'], columns: [{ table: 'TSIUSU', name: 'EMAIL' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['EMAIL'] })],
    effect: 'DENY',
  },
  {
    name: 'a * column in the request hits every column DENY',
    request: req({ columns: [{ table: 'TGFPAR', name: '*' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
  },
  {
    name: 'entity glob TGF* matches TGFPAR',
    request: req(),
    rules: [rule({ id: 'deny-tgf', effect: 'DENY', entities: ['TGF*'] })],
    effect: 'DENY',
  },
  {
    name: 'entity glob TGF* does not match TSIUSU',
    request: req({ entities: ['TSIUSU'] }),
    rules: [rule({ id: 'deny-tgf', effect: 'DENY', entities: ['TGF*'] })],
    effect: 'ALLOW',
  },
  {
    name: 'a DENY hits when any of the request entities matches',
    request: req({ entities: ['TSIUSU', 'TGFPAR'] }),
    rules: [rule({ id: 'deny-tgf', effect: 'DENY', entities: ['tgf*'] })],
    effect: 'DENY',
  },
  {
    name: 'environment filter: DENY scoped to PRODUCTION does not apply in HOMOLOGATION',
    request: req(),
    rules: [rule({ id: 'deny-prod', effect: 'DENY', environments: ['PRODUCTION'] })],
    effect: 'ALLOW',
  },
  {
    name: 'environment filter: DENY scoped to PRODUCTION applies in PRODUCTION',
    request: req({ environment: 'PRODUCTION' }),
    rules: [rule({ id: 'deny-prod', effect: 'DENY', environments: ['PRODUCTION'] })],
    effect: 'DENY',
  },
  {
    name: 'environment filter: ALLOW scoped to SANDBOX does not grant a write in HOMOLOGATION',
    request: update(),
    rules: [rule({ ...allowUpdate, environments: ['SANDBOX'] })],
    effect: 'DENY',
  },
  {
    name: 'connection filter: ALLOW for another connection does not grant',
    request: update(),
    rules: [rule({ ...allowUpdate, connectionIds: ['c2'] })],
    effect: 'DENY',
  },
  {
    name: 'connection filter: ALLOW for this connection grants',
    request: update(),
    rules: [rule({ ...allowUpdate, connectionIds: ['c2', 'c1'] })],
    effect: 'ALLOW',
  },
  {
    name: 'a write without an ALLOW rule is denied even with DATA.UPDATE',
    request: update(),
    rules: [],
    effect: 'DENY',
    reason: /no ALLOW rule/,
  },
  {
    name: 'an ALLOW for another action does not grant the write',
    request: update(),
    rules: [rule({ id: 'allow-ins', actions: ['DATA.INSERT'] })],
    effect: 'DENY',
  },
  {
    name: 'an action glob DATA.* grants DATA.UPDATE',
    request: update(),
    rules: [rule({ id: 'allow-data', actions: ['DATA.*'] })],
    effect: 'ALLOW',
  },
  {
    name: 'an ALLOW with empty actions grants nothing',
    request: update(),
    rules: [rule({ id: 'allow-none', actions: [] })],
    effect: 'DENY',
  },
  {
    name: 'a write must have every entity covered by an ALLOW',
    request: update({ entities: ['TGFPAR', 'TSIUSU'] }),
    rules: [allowUpdate],
    effect: 'DENY',
  },
  {
    name: 'a write is granted when ALLOW rules together cover every entity',
    request: update({ entities: ['TGFPAR', 'TSIUSU'] }),
    rules: [allowUpdate, rule({ id: 'allow-tsi', actions: ['DATA.UPDATE'], entities: ['TSI*'] })],
    effect: 'ALLOW',
  },
  {
    name: 'a write with no target entity is denied',
    request: update({ entities: [] }),
    rules: [allowUpdate],
    effect: 'DENY',
  },
  {
    name: 'a column-scoped ALLOW does not cover other columns',
    request: update({ columns: [{ table: 'TGFPAR', name: 'EMAIL' }] }),
    rules: [rule({ ...allowUpdate, columns: ['NOMEPARC'] })],
    effect: 'DENY',
  },
  {
    name: 'a column-scoped ALLOW covers its columns',
    request: update(),
    rules: [rule({ ...allowUpdate, columns: ['TGFPAR.NOMEPARC'] })],
    effect: 'ALLOW',
  },
  {
    name: 'an admin without DATA.UPDATE is denied an UPDATE (no hidden bypass)',
    request: update(),
    rules: [allowUpdate],
    permissions: ADMIN,
    effect: 'DENY',
    reason: /permission missing/,
  },
  {
    name: 'DDL and SANKHYA actions are default-deny too',
    request: req({ action: 'DDL.CUSTOM.GENERATE' }),
    rules: [],
    effect: 'DENY',
  },
  {
    name: 'SANKHYA actions are default-deny',
    request: req({ action: 'SANKHYA.BUSINESS_ACTION.EXECUTE' }),
    rules: [],
    effect: 'DENY',
  },
  {
    name: 'UPDATE without WHERE is denied',
    request: update({ hasWhere: false }),
    rules: [allowUpdate],
    effect: 'DENY',
    reason: /WHERE/,
  },
  {
    name: 'DELETE without WHERE is denied',
    request: req({ action: 'DATA.DELETE', hasWhere: false }),
    rules: [rule({ id: 'allow-del', actions: ['DATA.DELETE'] })],
    effect: 'DENY',
  },
  {
    name: 'INSERT needs no WHERE',
    request: req({ action: 'DATA.INSERT', hasWhere: false }),
    rules: [rule({ id: 'allow-ins', actions: ['DATA.INSERT'] })],
    effect: 'ALLOW',
  },
  {
    name: 'a WHERE override is ignored unless its rule covers every entity',
    request: update({ hasWhere: false, entities: ['TGFPAR', 'TSIUSU'] }),
    rules: [
      rule({ ...allowUpdate, overrideWhereRequired: true }),
      rule({ id: 'allow-tsi', actions: ['DATA.UPDATE'], entities: ['TSIUSU'] }),
    ],
    effect: 'DENY',
  },
  {
    name: 'a requireWhere limit beats the WHERE override',
    request: update({ hasWhere: false }),
    rules: [
      rule({ ...allowUpdate, overrideWhereRequired: true }),
      rule({ id: 'need-where', actions: ['DATA.*'], limits: { requireWhere: true } }),
    ],
    effect: 'DENY',
  },
  {
    name: 'disabled DENY rules never match',
    request: req(),
    rules: [rule({ id: 'deny-all', effect: 'DENY', enabled: false })],
    effect: 'ALLOW',
  },
  {
    name: 'disabled ALLOW rules never grant',
    request: update(),
    rules: [rule({ ...allowUpdate, enabled: false })],
    effect: 'DENY',
  },
  {
    name: 'an unknown action is denied',
    request: req({ action: 'DATA.TRUNCATE' as Permission }),
    rules: [rule({ id: 'allow-all' })],
    permissions: new Set(['DATA.TRUNCATE' as Permission]),
    effect: 'DENY',
    reason: /unknown action/,
  },
  {
    name: 'an unknown environment is denied',
    request: req({ environment: 'DEV' as PolicyRequest['environment'] }),
    rules: [],
    effect: 'DENY',
    reason: /unknown environment/,
  },
  {
    name: 'a malformed enabled rule denies everything (fail closed)',
    request: req(),
    rules: [rule({ id: 'bad', effect: 'MAYBE' as PolicyRule['effect'] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },
  {
    name: 'a rule with an unknown subject type denies everything (fail closed)',
    request: req(),
    rules: [rule({ id: 'bad', subjectType: 'role' as PolicyRule['subjectType'] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },
  {
    name: 'a user rule without a subject id is invalid',
    request: req(),
    rules: [rule({ id: 'bad', subjectType: 'user', subjectId: null })],
    effect: 'DENY',
  },
  {
    name: 'a negative row limit is invalid',
    request: req(),
    rules: [rule({ id: 'bad', limits: { maxReadRows: -1 } })],
    effect: 'DENY',
  },
  {
    name: 'an unknown limit key is invalid',
    request: req(),
    rules: [rule({ id: 'bad', limits: { maxRows: 5 } as PolicyRule['limits'] })],
    effect: 'DENY',
  },
  {
    name: 'a malformed disabled rule is ignored',
    request: req(),
    rules: [rule({ id: 'bad', effect: 'MAYBE' as PolicyRule['effect'], enabled: false })],
    effect: 'ALLOW',
  },
];

describe('evaluatePolicy', () => {
  it.each(cases)('$name', ({ request, rules, permissions, effect, reason }) => {
    const d = evaluatePolicy(request, rules, permissions ?? ALL);
    expect(d.effect).toBe(effect);
    if (reason) expect(d.reasons.join('\n')).toMatch(reason);
    if (effect === 'DENY') expect(d.reasons.length).toBeGreaterThan(0);
  });

  it('applies the defaults when no rule sets limits', () => {
    const d = evaluatePolicy(req(), [], ALL);
    expect(d.limits).toEqual(DEFAULT_LIMITS);
    expect(DEFAULT_LIMITS).toMatchObject({
      maxReadRows: 1000,
      maxWriteRows: 50,
      requirePreview: true,
      requireConfirmation: true,
    });
  });

  it('combines limits to the most restrictive (min rows, OR flags)', () => {
    const d = evaluatePolicy(
      update(),
      [
        rule({ ...allowUpdate, limits: { maxWriteRows: 20, maxReadRows: 500 } }),
        rule({ id: 'r2', actions: ['DATA.*'], limits: { maxWriteRows: 5, requireApproval: true } }),
        rule({
          id: 'r3',
          actions: ['DATA.*'],
          limits: { maxReadRows: 800, requireApproval: false },
        }),
      ],
      ALL,
    );
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.maxWriteRows).toBe(5);
    expect(d.limits.maxReadRows).toBe(500);
    expect(d.limits.requireApproval).toBe(true);
    expect(d.matchedRuleIds.sort()).toEqual(['allow-upd', 'r2', 'r3']);
  });

  it('a rule cannot switch off a default flag', () => {
    const d = evaluatePolicy(req(), [rule({ id: 'lax', limits: { requirePreview: false } })], ALL);
    expect(d.limits.requirePreview).toBe(true);
  });

  it('read limits apply from ALLOW rules overlapping any entity', () => {
    const d = evaluatePolicy(
      req({ entities: ['TSIUSU', 'TGFPAR'] }),
      [rule({ id: 'cap', entities: ['TGF*'], limits: { maxReadRows: 10 } })],
      ALL,
    );
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.maxReadRows).toBe(10);
  });

  it('limits of non-matching rules are ignored', () => {
    const d = evaluatePolicy(
      req(),
      [rule({ id: 'cap', environments: ['PRODUCTION'], limits: { maxReadRows: 10 } })],
      ALL,
    );
    expect(d.limits.maxReadRows).toBe(1000);
  });

  it('the WHERE override allows with strong confirmation and approval required', () => {
    const d = evaluatePolicy(
      update({ hasWhere: false }),
      [rule({ ...allowUpdate, overrideWhereRequired: true })],
      ALL,
    );
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.requireStrongConfirmation).toBe(true);
    expect(d.limits.requireApproval).toBe(true);
    expect(d.limits.requireWhere).toBe(false);
  });

  it('UPDATE and DELETE report requireWhere', () => {
    expect(evaluatePolicy(update(), [allowUpdate], ALL).limits.requireWhere).toBe(true);
  });

  it('production forces confirmation and strong confirmation for writes', () => {
    const d = evaluatePolicy(update({ environment: 'PRODUCTION' }), [allowUpdate], ALL);
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.requireConfirmation).toBe(true);
    expect(d.limits.requireStrongConfirmation).toBe(true);
  });

  it('outside production a write does not force strong confirmation', () => {
    const d = evaluatePolicy(update(), [allowUpdate], ALL);
    expect(d.limits.requireStrongConfirmation).toBe(false);
  });

  it('production does not force strong confirmation for reads', () => {
    const d = evaluatePolicy(req({ environment: 'PRODUCTION' }), [], ALL);
    expect(d.limits.requireStrongConfirmation).toBe(false);
  });

  it('reports the matched rule ids and the policy version', () => {
    const rules = [allowUpdate, rule({ id: 'deny-tsi', effect: 'DENY', entities: ['TSI*'] })];
    const d = evaluatePolicy(update(), rules, ALL);
    expect(d.matchedRuleIds).toEqual(['allow-upd']);
    expect(d.policyVersion).toBe(policyVersion(rules));
  });

  it('uses a precomputed policy version when given one', () => {
    const d = evaluatePolicy(req(), [], ALL, { policyVersion: 'v-cached' });
    expect(d.policyVersion).toBe('v-cached');
  });

  it('does not mutate its inputs', () => {
    const rules = [allowUpdate];
    const snapshot = JSON.stringify(rules);
    evaluatePolicy(update({ environment: 'PRODUCTION' }), rules, ALL);
    expect(JSON.stringify(rules)).toBe(snapshot);
  });
});

describe('policyVersion', () => {
  const base = [allowUpdate, rule({ id: 'deny-tsi', effect: 'DENY', entities: ['TSI*'] })];

  it('is a sha256 hex digest', () => {
    expect(policyVersion(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores rule order and key order', () => {
    const reordered = [...base]
      .reverse()
      .map((r) => Object.fromEntries(Object.entries(r).reverse()) as unknown as PolicyRule);
    expect(policyVersion(reordered)).toBe(policyVersion(base));
  });

  it.each<[string, Partial<PolicyRule>]>([
    ['name', { name: 'other' }],
    ['effect', { effect: 'DENY' }],
    ['subject', { subjectType: 'user', subjectId: 'u9' }],
    ['environments', { environments: ['SANDBOX'] }],
    ['connections', { connectionIds: ['c9'] }],
    ['actions', { actions: ['DATA.INSERT'] }],
    ['entities', { entities: ['TGF*'] }],
    ['columns', { columns: ['EMAIL'] }],
    ['limits', { limits: { maxWriteRows: 1 } }],
    ['override', { overrideWhereRequired: true }],
    ['enabled', { enabled: false }],
  ])('changes when %s changes', (_field, change) => {
    const changed = [{ ...base[0]!, ...change }, base[1]!];
    expect(policyVersion(changed)).not.toBe(policyVersion(base));
  });

  it('changes when a rule is added or removed', () => {
    expect(policyVersion([base[0]!])).not.toBe(policyVersion(base));
    expect(policyVersion([])).not.toBe(policyVersion(base));
  });
});
