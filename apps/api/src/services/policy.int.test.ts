import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { evaluatePolicy, isAppError, policyVersion } from '@dbx/shared';
import type { Permission, PolicyRequest } from '@dbx/shared';
import { PolicyService } from './policy';
import type { PolicyInput, PolicyLogger } from './policy';

// Fictitious ids, used only by these tests.
const USER_ID = '00000000-0000-4000-8000-000000000001';
const CONN_A = '00000000-0000-4000-8000-0000000000aa';
const CONN_B = '00000000-0000-4000-8000-0000000000bb';

const FULL: PolicyInput = {
  name: 'Writers on demo tables',
  effect: 'ALLOW',
  subjectType: 'user',
  subjectId: USER_ID,
  environments: ['SANDBOX', 'HOMOLOGATION'],
  connectionIds: [CONN_A, CONN_B],
  actions: ['DATA.UPDATE', 'DATA.INSERT'],
  entities: ['TGF*', 'SANKHYA.TGFPAR'],
  columns: ['TGFPAR.EMAIL', 'NOMEPARC'],
  limits: { maxWriteRows: 10, maxReadRows: 500, requireApproval: true },
  overrideWhereRequired: true,
  enabled: false,
};

const SIMPLE: PolicyInput = {
  name: 'Deny secrets',
  effect: 'DENY',
  subjectType: 'everyone',
  subjectId: null,
  environments: [],
  connectionIds: [],
  actions: ['QUERY.SELECT'],
  entities: ['SECRETS'],
  columns: [],
  limits: {},
  overrideWhereRequired: false,
  enabled: true,
};

const SELECT_REQ: PolicyRequest = {
  userId: USER_ID,
  groupIds: [],
  action: 'QUERY.SELECT',
  environment: 'SANDBOX',
  connectionId: CONN_A,
  entities: ['TGFPRO'],
  columns: [],
  hasWhere: true,
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup() {
  const database: DatabaseHandle = await createDatabase('pglite:memory');
  await database.migrate();
  cleanup.push(() => database.close());
  const logger: PolicyLogger = { error: vi.fn(), warn: vi.fn() };
  const service = new PolicyService(database.db, logger);
  return { database, service, logger };
}

async function expectValidation(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(isAppError(err) && err.code).toBe('VALIDATION_ERROR');
}

describe('PolicyService', () => {
  it('round-trips every column', async () => {
    const { service } = await setup();
    const created = await service.create(FULL);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof created.updatedAt).toBe('string');
    const { id, updatedAt, ...rest } = created;
    void id;
    void updatedAt;
    expect(rest).toEqual(FULL);

    const listed = await service.list();
    expect(listed).toEqual([created]);
    const snap = await service.current();
    expect(snap.invalid).toEqual([]);
    expect(snap.rules).toEqual([{ ...FULL, id: created.id }]);
    expect(snap.version).toBe(policyVersion(snap.rules));
  });

  it('stores null subjectId for everyone and applies column defaults', async () => {
    const { service } = await setup();
    const created = await service.create({ ...SIMPLE, subjectId: USER_ID });
    expect(created.subjectId).toBeNull();
    expect(created.environments).toEqual([]);
    expect(created.limits).toEqual({});
  });

  it('validates on create, update and refuses unknown ids', async () => {
    const { service } = await setup();
    await expectValidation(service.create({ ...SIMPLE, actions: [] }));
    await expectValidation(service.create({ ...SIMPLE, actions: ['DATA.NOPE'] }));
    await expectValidation(
      service.create({
        ...SIMPLE,
        environments: ['MOON'] as unknown as PolicyInput['environments'],
      }),
    );
    await expectValidation(service.create({ ...SIMPLE, limits: { maxReadRows: -1 } }));
    await expectValidation(
      service.create({ ...SIMPLE, limits: { bogus: true } as unknown as PolicyInput['limits'] }),
    );
    await expectValidation(service.create({ ...SIMPLE, subjectType: 'user', subjectId: null }));
    await expectValidation(
      service.create({ ...SIMPLE, subjectType: 'user', subjectId: 'not-a-uuid' }),
    );
    await expectValidation(service.create({ ...SIMPLE, connectionIds: ['env-default'] }));
    await expectValidation(service.create({ ...SIMPLE, entities: ['a.b.c'] }));
    await expectValidation(service.create({ ...SIMPLE, name: '  ' }));
    await expectValidation(service.create(null as unknown as PolicyInput));
    expect(await service.list()).toEqual([]);

    const created = await service.create(SIMPLE);
    await expectValidation(service.update(created.id, { actions: ['nope'] }));
    await expectValidation(service.update(created.id, { effect: 'MAYBE' as 'ALLOW' }));
    expect((await service.list())[0]).toEqual(created);

    const missing = '00000000-0000-4000-8000-00000000ffff';
    const notFound = (e: unknown) => isAppError(e) && e.code;
    expect(await service.update(missing, { name: 'x' }).catch(notFound)).toBe('NOT_FOUND');
    expect(await service.delete(missing).catch(notFound)).toBe('NOT_FOUND');
    expect(await service.delete('not-a-uuid').catch(notFound)).toBe('NOT_FOUND');
  });

  it('updates and deletes', async () => {
    const { service } = await setup();
    const created = await service.create(SIMPLE);
    const updated = await service.update(created.id, { name: 'Renamed', enabled: false });
    expect(updated).toMatchObject({ ...SIMPLE, id: created.id, name: 'Renamed', enabled: false });
    await service.delete(created.id);
    expect(await service.list()).toEqual([]);
  });

  it('fails closed globally on a corrupt stored rule and reports it', async () => {
    const { database, service, logger } = await setup();
    const good = await service.create(SIMPLE);
    const permissions = new Set<Permission>(['QUERY.SELECT']);
    let snap = await service.current();
    expect(evaluatePolicy(SELECT_REQ, snap.rules, permissions).effect).toBe('ALLOW');

    // Bypasses the service: an empty action list would make a DENY silently inert.
    await database.db.execute(sql`
      insert into policies (name, effect, subject_type, actions, environments, enabled)
      values ('corrupt', 'DENY', 'everyone', '{}', '{MOON}', true)`);
    await service.load();
    snap = await service.current();
    expect(snap.invalid).toHaveLength(1);
    expect(snap.invalid[0]).toMatch(/corrupt/);
    expect(logger.error).toHaveBeenCalled();
    const decision = evaluatePolicy(SELECT_REQ, snap.rules, permissions, {
      policyVersion: snap.version,
    });
    expect(decision.effect).toBe('DENY');
    expect(decision.reasons.join(' ')).toMatch(/invalid rule/);

    // A corrupt but disabled rule is ignored by the evaluator and not reported as blocking.
    await database.db.execute(sql`update policies set enabled = false where name = 'corrupt'`);
    await service.load();
    snap = await service.current();
    expect(snap.invalid).toEqual([]);
    expect(evaluatePolicy(SELECT_REQ, snap.rules, permissions).effect).toBe('ALLOW');
    expect(snap.rules.map((r) => r.id)).toContain(good.id);
  });

  it('changes the version when a rule changes and invalidates the cache on writes', async () => {
    const { database, service } = await setup();
    const empty = await service.current();
    expect(empty.rules).toEqual([]);

    const created = await service.create(SIMPLE);
    const v1 = await service.current();
    expect(v1.rules).toHaveLength(1);
    expect(v1.version).not.toBe(empty.version);

    // Cached: a change made behind the service is not seen until invalidate().
    await database.db.execute(sql`update policies set name = 'outside' where id = ${created.id}`);
    expect((await service.current()).version).toBe(v1.version);
    service.invalidate();
    const v2 = await service.current();
    expect(v2.rules[0]!.name).toBe('outside');
    expect(v2.version).not.toBe(v1.version);

    await service.update(created.id, { entities: ['OTHER'] });
    const v3 = await service.current();
    expect(v3.rules[0]!.entities).toEqual(['OTHER']);
    expect(v3.version).not.toBe(v2.version);

    await service.delete(created.id);
    const v4 = await service.current();
    expect(v4.rules).toEqual([]);
    expect(v4.version).toBe(empty.version);
  });

  it('does not cache a load error: the next call re-reads', async () => {
    const { database, service } = await setup();
    await service.create(SIMPLE);
    service.invalidate();
    const spy = vi.spyOn(database.db, 'select').mockImplementationOnce(() => {
      throw new Error('database down');
    });
    await expect(service.current()).rejects.toThrow('database down');
    spy.mockRestore();
    const snap = await service.current();
    expect(snap.rules).toHaveLength(1);
  });

  it('does not keep a stale version from a read in flight during an update', async () => {
    const { service } = await setup();
    const created = await service.create(SIMPLE);
    const before = await service.current();
    service.invalidate();
    const inFlight = service.current();
    await service.update(created.id, { entities: ['OTHER'] });
    await inFlight;
    const after = await service.current();
    expect(after.rules[0]!.entities).toEqual(['OTHER']);
    expect(after.version).not.toBe(before.version);
    expect(after.version).toBe(policyVersion(after.rules));
  });

  it('keeps both of two concurrent updates', async () => {
    const { service } = await setup();
    const created = await service.create(SIMPLE);
    await Promise.all([
      service.update(created.id, { name: 'Concurrent' }),
      service.update(created.id, { entities: ['OTHER'] }),
    ]);
    const [row] = await service.list();
    expect(row).toMatchObject({ name: 'Concurrent', entities: ['OTHER'] });
  });

  it('refuses switching to a user subject without a subjectId', async () => {
    const { service } = await setup();
    const created = await service.create(SIMPLE);
    await expectValidation(service.update(created.id, { subjectType: 'user' }));
    await expectValidation(service.update(created.id, { subjectType: 'user', subjectId: null }));
  });

  it('lets an admin disable a corrupt rule, and only that', async () => {
    const { database, service } = await setup();
    await database.db.execute(sql`
      insert into policies (name, effect, subject_type, actions, enabled)
      values ('corrupt', 'DENY', 'everyone', '{}', true)`);
    const [corrupt] = await service.list();
    await expectValidation(service.update(corrupt!.id, { name: 'renamed' }));
    await expectValidation(service.update(corrupt!.id, { enabled: false, name: 'renamed' }));
    await expectValidation(service.update(corrupt!.id, { enabled: true }));
    expect((await service.current()).invalid).toHaveLength(1);

    const disabled = await service.update(corrupt!.id, { enabled: false });
    expect(disabled).toMatchObject({ name: 'corrupt', actions: [], enabled: false });
    expect((await service.current()).invalid).toEqual([]);
  });

  it('evaluates over the current rules and never throws', async () => {
    const { database, service, logger } = await setup();
    const permissions = new Set<Permission>(['QUERY.SELECT']);
    await service.create(SIMPLE);
    const snap = await service.current();
    const allowed = await service.evaluate(SELECT_REQ, permissions);
    expect(allowed.effect).toBe('ALLOW');
    expect(allowed.policyVersion).toBe(snap.version);
    const denied = await service.evaluate({ ...SELECT_REQ, entities: ['SECRETS'] }, permissions);
    expect(denied.effect).toBe('DENY');

    // Load failure: DENY with a clear reason, logged, not thrown.
    service.invalidate();
    const spy = vi.spyOn(database.db, 'select').mockImplementationOnce(() => {
      throw new Error('database down');
    });
    const down = await service.evaluate(SELECT_REQ, permissions);
    spy.mockRestore();
    expect(down).toMatchObject({ effect: 'DENY', reasons: ['policies unavailable'] });
    expect(logger.error).toHaveBeenCalled();
    expect((await service.evaluate(SELECT_REQ, permissions)).effect).toBe('ALLOW');

    // A malformed request is denied, not thrown.
    const odd = await service.evaluate(null as unknown as PolicyRequest, permissions);
    expect(odd.effect).toBe('DENY');

    // A corrupt enabled rule: every action denied, naming the rule.
    await database.db.execute(sql`
      insert into policies (name, effect, subject_type, actions, enabled)
      values ('corrupt', 'DENY', 'everyone', '{}', true)`);
    await service.load();
    const corrupt = await service.evaluate(SELECT_REQ, permissions);
    expect(corrupt.effect).toBe('DENY');
    expect(corrupt.reasons.join(' ')).toMatch(/invalid policy rule .*corrupt/);
  });
});
