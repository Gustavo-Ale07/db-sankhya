import { describe, expect, it } from 'vitest';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, type Permission } from './permissions';
import {
  DEFAULT_LIMITS,
  POLICY_ACTION_CLASS,
  evaluatePolicy,
  isPolicyWriteAction,
  policyVersion,
  sha256HexUtf8,
  type EffectiveLimits,
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
    // Padding boundaries: 55/56 bytes straddle the one-block limit, 63/64 and 119/120 the next.
    ['a'.repeat(55), '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
    ['a'.repeat(56), 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a'],
    ['a'.repeat(63), '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34'],
    ['a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
    ['a'.repeat(119), '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb'],
    ['a'.repeat(120), '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
    ['\ud800', '83d544ccc223c057d2bf80d3f2a32982c32c3c0db8e2674820da5064783fb097'],
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
    name: 'DENY on a group beats ALLOW on the user, whatever the rule order',
    request: update(),
    rules: [
      rule({ id: 'deny-g1', effect: 'DENY', subjectType: 'group', subjectId: 'g1' }),
      rule({ ...allowUpdate, subjectType: 'user', subjectId: 'u1' }),
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
    name: 'an ALLOW with empty actions is invalid (grants nothing)',
    request: update(),
    rules: [rule({ id: 'allow-none', actions: [] })],
    effect: 'DENY',
    reason: /invalid rule allow-none/,
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
    name: 'DDL actions are default-deny too',
    request: req({ action: 'DDL.CUSTOM.GENERATE' }),
    rules: [],
    effect: 'DENY',
    reason: /no ALLOW rule/,
  },
  {
    name: 'a DDL ALLOW on other entities does not grant',
    request: req({ action: 'DDL.CUSTOM.GENERATE' }),
    rules: [rule({ id: 'allow-ddl', actions: ['DDL.*'], entities: ['AD_*'] })],
    effect: 'DENY',
    reason: /no ALLOW rule .* on TGFPAR/,
  },
  {
    name: 'an ALLOW on the entity grants a DDL action',
    request: req({ action: 'DDL.CUSTOM.GENERATE', entities: ['AD_TESTE'] }),
    rules: [rule({ id: 'allow-ddl', actions: ['DDL.*'], entities: ['AD_*'] })],
    effect: 'ALLOW',
  },
  {
    name: 'SANKHYA actions are default-deny',
    request: req({ action: 'SANKHYA.BUSINESS_ACTION.EXECUTE' }),
    rules: [],
    effect: 'DENY',
    reason: /no ALLOW rule/,
  },
  {
    name: 'an ALLOW grants a SANKHYA action',
    request: req({ action: 'SANKHYA.BUSINESS_ACTION.EXECUTE' }),
    rules: [rule({ id: 'allow-sk', actions: ['SANKHYA.BUSINESS_ACTION.EXECUTE'] })],
    effect: 'ALLOW',
  },
  {
    name: 'permission-only admin actions are allowed by permission alone',
    request: req({ action: 'AUDIT.READ', entities: [] }),
    rules: [],
    effect: 'ALLOW',
  },
  {
    name: 'a write is denied when a DENY hits the second of two entities',
    request: update({ entities: ['TGFPAR', 'TSIUSU'], columns: [] }),
    rules: [
      rule({ id: 'allow-data', actions: ['DATA.*'] }),
      rule({ id: 'deny-tsi', effect: 'DENY', entities: ['TSIUSU'] }),
    ],
    effect: 'DENY',
    reason: /deny-tsi/,
  },
  {
    name: 'a column DENY blocks UPDATE ... SET EMAIL despite an entity-wide ALLOW',
    request: update({ columns: [{ table: 'TGFPAR', name: 'EMAIL' }] }),
    rules: [allowUpdate, rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
    reason: /deny-email/,
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
    reason: /DATA.DELETE without WHERE/,
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

  // Finding 1: columns not attributed to a request entity fail closed.
  {
    name: 'an unattributed column cannot escape a column-scoped ALLOW',
    request: update({
      columns: [
        { table: 'TGFPAR', name: 'NOMEPARC' },
        { table: '', name: 'EMAIL' },
      ],
    }),
    rules: [rule({ ...allowUpdate, columns: ['NOMEPARC'] })],
    effect: 'DENY',
    reason: /malformed request/,
  },
  {
    name: 'a column on an alias is not attributed and is denied',
    request: update({ columns: [{ table: 'P', name: 'EMAIL' }] }),
    rules: [allowUpdate],
    effect: 'DENY',
    reason: /malformed request: column P.EMAIL/,
  },
  {
    name: 'a column with an empty table cannot bypass a column DENY',
    request: req({ columns: [{ table: '', name: 'EMAIL' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
    reason: /malformed request/,
  },
  {
    name: 'a column qualified by schema is attributed to the bare entity',
    request: req({ columns: [{ table: 'SANKHYA.TGFPAR', name: 'EMAIL' }] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
    reason: /deny-email/,
  },

  // Finding 2: malformed requests and inputs return DENY, never throw or fail open.
  ...(
    [
      ['entities null', { entities: null }],
      ['entities with an empty name', { entities: [''] }],
      ['groupIds null', { groupIds: null }],
      ['groupIds with a number', { groupIds: [1] }],
      ['userId empty', { userId: '' }],
      ['connectionId missing', { connectionId: undefined }],
      ['hasWhere as the string "false"', { hasWhere: 'false' }],
      ['hasWhere missing', { hasWhere: undefined }],
      ['columns not an array', { columns: 'EMAIL' }],
      ['a column without a name', { columns: [{ table: 'TGFPAR' }] }],
      ['a null column', { columns: [null] }],
    ] as Array<[string, Record<string, unknown>]>
  ).map(([what, over]): Case => ({
    name: `a malformed request (${what}) is denied`,
    request: update(over as Partial<PolicyRequest>),
    rules: [rule({ id: 'allow-all', actions: ['*'] })],
    effect: 'DENY',
    reason: /malformed request/,
  })),
  {
    name: 'a null action is denied',
    request: req({ action: null as unknown as Permission }),
    rules: [],
    effect: 'DENY',
    reason: /unknown action/,
  },
  {
    name: 'a null entry in the policy list is invalid',
    request: req(),
    rules: [null as unknown as PolicyRule],
    effect: 'DENY',
    reason: /invalid rule/,
  },
  {
    name: 'a policy list that is not an array is denied',
    request: req(),
    rules: { length: 0 } as unknown as PolicyRule[],
    effect: 'DENY',
  },
  {
    name: 'a permissions value that is not a set is denied',
    request: req(),
    rules: [],
    permissions: ['QUERY.SELECT'] as unknown as Set<Permission>,
    effect: 'DENY',
    reason: /permission missing/,
  },

  // Finding 3: a DENY can never be silently inert.
  {
    name: 'a DENY with empty actions is invalid',
    request: update(),
    rules: [allowUpdate, rule({ id: 'deny-x', effect: 'DENY', actions: [], entities: ['TGFPAR'] })],
    effect: 'DENY',
    reason: /invalid rule deny-x/,
  },
  {
    name: 'a DENY with a misspelled action is invalid',
    request: update(),
    rules: [allowUpdate, rule({ id: 'deny-x', effect: 'DENY', actions: ['DATA.UPADTE'] })],
    effect: 'DENY',
    reason: /invalid rule deny-x/,
  },
  {
    name: 'an action glob that matches no permission is invalid',
    request: req(),
    rules: [rule({ id: 'bad', actions: ['DML.*'] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },
  {
    name: 'an entity pattern with surrounding whitespace is invalid',
    request: req(),
    rules: [rule({ id: 'bad', effect: 'DENY', entities: [' TGFPAR'] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },
  {
    name: 'a column pattern with surrounding whitespace is invalid',
    request: req(),
    rules: [rule({ id: 'bad', effect: 'DENY', columns: ['EMAIL '] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },
  {
    name: 'a padded, upper-case rule connection id is trimmed and lower-cased',
    request: req(),
    rules: [rule({ id: 'deny-c1', effect: 'DENY', connectionIds: [' C1 '] })],
    effect: 'DENY',
    reason: /deny-c1/,
  },
  {
    name: 'an empty rule connection id is invalid',
    request: req(),
    rules: [rule({ id: 'bad', connectionIds: [' '] })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  },

  // Finding 4: normalized identifiers.
  ...['SANKHYA.TGFPAR', 'dbo.TGFPAR', '"TGFPAR"', '[TGFPAR]', '[dbo].[tgfpar]', ' tgfpar '].map(
    (entity): Case => ({
      name: `an entity DENY on TGFPAR hits ${entity}`,
      request: update({ entities: [entity], columns: [] }),
      rules: [
        rule({ id: 'allow-data', actions: ['DATA.*'] }),
        rule({ id: 'deny-tgfpar', effect: 'DENY', entities: ['TGFPAR'] }),
      ],
      effect: 'DENY',
      reason: /deny-tgfpar/,
    }),
  ),
  {
    name: 'a schema-qualified DENY pattern hits the qualified entity',
    request: req({ entities: ['sankhya.TGFPAR'] }),
    rules: [rule({ id: 'deny-q', effect: 'DENY', entities: ['SANKHYA.TGF*'] })],
    effect: 'DENY',
  },
  {
    name: 'a connection DENY hits an upper-case connection id',
    request: update({ connectionId: 'C1' }),
    rules: [
      rule({ id: 'allow-data', actions: ['DATA.*'] }),
      rule({ id: 'deny-c1', effect: 'DENY', connectionIds: ['c1'] }),
    ],
    effect: 'DENY',
    reason: /deny-c1/,
  },
  {
    name: 'a user DENY hits a differently-cased, padded user id',
    request: req({ userId: ' U1 ' }),
    rules: [rule({ id: 'deny-u1', effect: 'DENY', subjectType: 'user', subjectId: 'u1' })],
    effect: 'DENY',
  },
  {
    name: 'a group DENY hits a differently-cased group id',
    request: req({ groupIds: ['G1'] }),
    rules: [rule({ id: 'deny-g1', effect: 'DENY', subjectType: 'group', subjectId: 'g1' })],
    effect: 'DENY',
  },
  {
    name: 'a group rule does not apply through a matching user id',
    request: req({ groupIds: [] }),
    rules: [rule({ id: 'deny-g', effect: 'DENY', subjectType: 'group', subjectId: 'u1' })],
    effect: 'ALLOW',
  },

  // Finding 5 / 10: invalid limit values and inherited properties.
  ...(
    [
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['a float', 1.5],
      ['a string', '10'],
    ] as Array<[string, unknown]>
  ).map(([what, value]): Case => ({
    name: `a row limit that is ${what} is invalid`,
    request: req(),
    rules: [rule({ id: 'bad', limits: { maxWriteRows: value as number } })],
    effect: 'DENY',
    reason: /invalid rule bad/,
  })),
  {
    name: 'an inherited overrideWhereRequired does not count (rule invalid)',
    request: update({ hasWhere: false }),
    rules: [
      (() => {
        const r: Record<string, unknown> = Object.create({ overrideWhereRequired: true });
        Object.assign(r, allowUpdate);
        delete r.overrideWhereRequired;
        return r as unknown as PolicyRule;
      })(),
    ],
    effect: 'DENY',
    reason: /invalid rule allow-upd/,
  },
  {
    name: 'an inherited enabled flag does not enable a rule',
    request: req(),
    rules: [
      (() => {
        const r: Record<string, unknown> = Object.create({ enabled: true });
        Object.assign(r, rule({ id: 'deny-all', effect: 'DENY' }));
        delete r.enabled;
        return r as unknown as PolicyRule;
      })(),
    ],
    effect: 'ALLOW',
  },

  // Finding 9: unknown columns are treated as `*`.
  {
    name: 'columns undefined (unknown) is hit by a column DENY',
    request: req({ columns: undefined }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'DENY',
    reason: /deny-email/,
  },
  {
    name: 'columns [] (known none) is not hit by a column DENY',
    request: req({ columns: [] }),
    rules: [rule({ id: 'deny-email', effect: 'DENY', columns: ['TGFPAR.EMAIL'] })],
    effect: 'ALLOW',
  },
  {
    name: 'columns undefined is never covered by a column-scoped ALLOW',
    request: update({ columns: undefined }),
    rules: [rule({ ...allowUpdate, columns: ['NOMEPARC'] })],
    effect: 'DENY',
    reason: /no ALLOW rule/,
  },

  // Finding 8: documented behaviour, every matching ALLOW is also a grant.
  {
    name: 'a limits-only ALLOW also grants the write (documented)',
    request: update({ entities: ['TSIUSU'], columns: [] }),
    rules: [rule({ id: 'cap', actions: ['DATA.*'], limits: { maxWriteRows: 5 } })],
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

  it('the defaults are ceilings: rules can only lower the row limits', () => {
    const d = evaluatePolicy(
      update(),
      [rule({ ...allowUpdate, limits: { maxWriteRows: 100000, maxReadRows: 5000 } })],
      ALL,
    );
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.maxWriteRows).toBe(50);
    expect(d.limits.maxReadRows).toBe(1000);
  });

  it('a row limit of 0 is valid and wins', () => {
    const d = evaluatePolicy(
      update(),
      [rule({ ...allowUpdate, limits: { maxWriteRows: 0 } })],
      ALL,
    );
    expect(d.limits.maxWriteRows).toBe(0);
  });

  it('configured defaults replace the ceilings and rules still lower them', () => {
    const defaults = { maxReadRows: 5000, maxWriteRows: 200 };
    const plain = evaluatePolicy(update(), [allowUpdate], ALL, { defaults });
    expect(plain.limits.maxReadRows).toBe(5000);
    expect(plain.limits.maxWriteRows).toBe(200);
    const capped = evaluatePolicy(
      update(),
      [rule({ ...allowUpdate, limits: { maxWriteRows: 100000, maxReadRows: 10 } })],
      ALL,
      { defaults },
    );
    expect(capped.limits.maxReadRows).toBe(10);
    expect(capped.limits.maxWriteRows).toBe(200);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null])(
    'an invalid configured default (%s) falls back to rule 7',
    (value) => {
      const defaults = { maxReadRows: value, maxWriteRows: value } as unknown as Partial<
        Pick<EffectiveLimits, 'maxReadRows' | 'maxWriteRows'>
      >;
      const d = evaluatePolicy(req(), [], ALL, { defaults });
      expect(d.limits.maxReadRows).toBe(1000);
      expect(d.limits.maxWriteRows).toBe(50);
    },
  );

  it('ignores inherited limits (prototype pollution cannot raise or poison them)', () => {
    const limits = Object.create({ maxWriteRows: Number.NaN, requireApproval: false });
    const d = evaluatePolicy(update(), [rule({ ...allowUpdate, limits })], ALL);
    expect(d.effect).toBe('ALLOW');
    expect(d.limits.maxWriteRows).toBe(50);
  });

  it('requirePreview and requireConfirmation are always true', () => {
    const d = evaluatePolicy(
      update(),
      [rule({ ...allowUpdate, limits: { requirePreview: false, requireConfirmation: false } })],
      ALL,
    );
    expect(d.limits.requirePreview).toBe(true);
    expect(d.limits.requireConfirmation).toBe(true);
  });

  it('returns DENY instead of throwing when an input throws', () => {
    const hostile = { ...req() };
    Object.defineProperty(hostile, 'entities', {
      enumerable: true,
      get() {
        throw new Error('boom');
      },
    });
    const d = evaluatePolicy(hostile, [], ALL);
    expect(d.effect).toBe('DENY');
    expect(d.reasons).toEqual(['policy evaluation failed']);
  });

  it('returns DENY when the policy version cannot be computed', () => {
    const cyclic: Record<string, unknown> = { ...rule({ id: 'c' }) };
    cyclic.self = cyclic;
    const d = evaluatePolicy(req(), [cyclic as unknown as PolicyRule], ALL);
    expect(d.effect).toBe('DENY');
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

describe('action classification', () => {
  it('only DATA.*, DDL.* and SANKHYA.* are writes', () => {
    const writes = PERMISSIONS.filter((p) => POLICY_ACTION_CLASS[p] === 'write');
    expect(writes).toEqual([
      'DATA.INSERT',
      'DATA.UPDATE',
      'DATA.DELETE',
      'DDL.CUSTOM.GENERATE',
      'SANKHYA.BUSINESS_ACTION.EXECUTE',
    ]);
    expect(Object.keys(POLICY_ACTION_CLASS).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('treats an unknown action as a write (fail closed)', () => {
    expect(isPolicyWriteAction('EXPORT.CSV')).toBe(true);
    expect(isPolicyWriteAction('toString')).toBe(true);
    expect(isPolicyWriteAction('QUERY.SELECT')).toBe(false);
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
