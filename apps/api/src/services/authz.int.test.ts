import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, groupMembers, groupRoles, rolePermissions, roles } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { PERMISSIONS, SYSTEM_ROLE_PERMISSIONS, SYSTEM_ROLES } from '@dbx/shared';
import type { AppError, Permission } from '@dbx/shared';
import { AuthzService, GUARD_LOCK_KEY } from './authz';
import { UsersService } from './users';

const PASSWORD = 'User!Strong#Pass9';

let database: DatabaseHandle;
let authz: AuthzService;
let users: UsersService;

beforeEach(async () => {
  database = await createDatabase('pglite:memory');
  await database.migrate();
  authz = new AuthzService(database.db);
  users = new UsersService(database.db, authz);
});

afterEach(async () => {
  await database.close();
});

const newUser = async (email: string, roleKeys: string[]) =>
  (await users.create({ email, name: email, password: PASSWORD, roles: roleKeys })).id;

/** Inserts a role directly, to set up state no actor could create through the service. */
const seedRole = async (key: string, permissions: readonly string[]) => {
  const [r] = await database.db
    .insert(roles)
    .values({ key, name: key, system: false })
    .returning({ id: roles.id });
  if (permissions.length > 0)
    await database.db
      .insert(rolePermissions)
      .values(permissions.map((permission) => ({ roleId: r!.id, permission })));
  return r!.id;
};

describe('AuthzService', () => {
  it('seeds exactly the catalog permissions for each system role', async () => {
    const listed = await authz.listRoles();
    expect(listed.map((r) => r.key).sort()).toEqual([...SYSTEM_ROLES].sort());
    for (const role of listed) {
      const expected = [
        ...SYSTEM_ROLE_PERMISSIONS[role.key as keyof typeof SYSTEM_ROLE_PERMISSIONS],
      ];
      expect(role.permissions, role.key).toEqual(expected.sort());
    }
  });

  it('unions direct roles with the roles of active groups only', async () => {
    const admin = await newUser('admin@example.com', ['ADMIN']);
    // Granting OPERATOR through a group needs an actor who holds it.
    const granter = await newUser('granter@example.com', ['ADMIN', 'OPERATOR']);
    const id = await newUser('ana@example.com', ['VIEWER']);
    expect([...(await authz.effectivePermissions(id))].sort()).toEqual([
      'QUERY.SELECT',
      'TEMP.CREATE',
      'TEMP.DROP',
      'TEMP.MATERIALIZE',
      'TEMP.WRITE',
    ]);

    const group = await authz.createGroup({ name: 'Operação' });
    await authz.setGroupRoles(group.id, ['OPERATOR'], granter);
    await authz.setGroupMembers(group.id, [id], granter);
    const grants = await authz.grants(id);
    expect(grants.roles).toEqual(['OPERATOR', 'VIEWER']);
    expect(grants.permissions.has('DATA.UPDATE')).toBe(true);
    expect(grants.permissions.has('DATA.DELETE')).toBe(false);
    expect(await authz.effectivePermissions(id)).toEqual(grants.permissions);
    expect((await authz.grants(admin)).permissions.has('DATA.UPDATE')).toBe(false);
  });

  it('grants nothing through a disabled group', async () => {
    const admin = await newUser('admin@example.com', ['ADMIN', 'OPERATOR']);
    const id = await newUser('bia@example.com', []);
    const group = await authz.createGroup({ name: 'Auditoria' });
    await authz.setGroupRoles(group.id, ['OPERATOR'], admin);
    await authz.setGroupMembers(group.id, [id], admin);
    expect((await authz.effectivePermissions(id)).has('DATA.INSERT')).toBe(true);
    await authz.updateGroup(group.id, { active: false }, admin);
    const grants = await authz.grants(id);
    expect(grants.roles).toEqual([]);
    expect(grants.permissions.size).toBe(0);
  });

  it('does not give ADMIN any DATA.*, DDL.* or SANKHYA.* permission', async () => {
    const admin = await newUser('admin@example.com', ['ADMIN']);
    const perms = await authz.effectivePermissions(admin);
    expect(perms.has('ADMIN.USERS')).toBe(true);
    expect(perms.has('DATA.UPDATE')).toBe(false);
    for (const p of perms) expect(p).not.toMatch(/^(DATA|DDL|SANKHYA)\./);
  });

  it('ignores permission strings outside the catalog (fail closed)', async () => {
    const id = await newUser('x@example.com', []);
    const role = await authz.createRole({ key: 'CUSTOM', name: 'Custom', permissions: [] }, id);
    await database.db
      .insert(rolePermissions)
      .values({ roleId: role.id, permission: 'DDL.NATIVE.EXECUTE' });
    await authz.assignUserRoles(id, ['CUSTOM'], database.db);
    const grants = await authz.grants(id);
    expect(grants.roles).toEqual(['CUSTOM']);
    expect(grants.permissions.size).toBe(0);
  });

  it('keeps at least one active administrator', async () => {
    const admin = await newUser('admin@example.com', ['ADMIN']);
    const other = await newUser('other@example.com', ['VIEWER']);
    // Removing roles needs an actor covering the target; an active one would keep ADMIN.USERS
    // themselves, so only a disabled peer can reach the last-administrator rule.
    const peer = await newUser('peer@example.com', ['ADMIN']);
    await users.update(peer, { active: false }, admin);
    await expect(authz.setUserRoles(admin, ['VIEWER'], peer)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(users.update(admin, { active: false }, other)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Admin through a group counts too; then the direct grant may go.
    const group = await authz.createGroup({ name: 'Admins' });
    // Set up directly: a VIEWER may not grant ADMIN (see the granting tests below).
    const [adminRole] = await database.db.select().from(roles).where(eq(roles.key, 'ADMIN'));
    await database.db.insert(groupRoles).values({ groupId: group.id, roleId: adminRole!.id });
    await database.db.insert(groupMembers).values({ groupId: group.id, userId: admin });
    await authz.setUserRoles(admin, ['VIEWER'], peer);
    expect((await authz.grants(admin)).permissions.has('ADMIN.USERS')).toBe(true);
    await expect(authz.updateGroup(group.id, { active: false }, other)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    await expect(authz.deleteGroup(group.id, peer)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses edits of system roles', async () => {
    const admin = await newUser('admin@example.com', ['ADMIN']);
    const peer = await newUser('peer@example.com', ['VIEWER']);
    const [system] = await database.db.select().from(roles).where(eq(roles.key, 'ADMIN'));
    await expect(
      authz.updateRole(system!.id, { permissions: ['DATA.UPDATE'] }, peer),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(authz.deleteRole(system!.id, peer)).rejects.toMatchObject({ code: 'CONFLICT' });
    // Renaming a held role changes no permission, so the holder may do it.
    const renamed = await authz.updateRole(system!.id, { name: 'Administração' }, admin);
    expect(renamed.permissions).not.toContain('DATA.UPDATE');
  });

  it('creates, edits and deletes custom roles', async () => {
    const actor = await newUser('admin@example.com', ['ADMIN']);
    const role = await authz.createRole(
      {
        key: 'AUDITOR',
        name: 'Auditor',
        permissions: ['AUDIT.READ', 'QUERY.SELECT', 'AUDIT.READ'],
      },
      actor,
    );
    expect(role.permissions).toEqual(['AUDIT.READ', 'QUERY.SELECT']);
    await expect(
      authz.createRole({ key: 'AUDITOR', name: 'Dup', permissions: [] }, actor),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const edited = await authz.updateRole(role.id, { permissions: ['AUDIT.READ'] }, actor);
    expect(edited.permissions).toEqual(['AUDIT.READ']);
    await authz.deleteRole(role.id, actor);
    await expect(authz.findRole(role.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it("refuses every change to the actor's own effective permissions", async () => {
    const actor = await newUser('admin@example.com', ['ADMIN']);
    const peer = await newUser('peer@example.com', ['ADMIN', 'OPERATOR']);
    const bia = await newUser('bia@example.com', ['VIEWER']);
    const forbidden = { code: 'FORBIDDEN' };
    const before = [...(await authz.effectivePermissions(actor))].sort();

    // Own direct roles.
    await expect(authz.setUserRoles(actor, ['ADMIN', 'OPERATOR'], actor)).rejects.toMatchObject(
      forbidden,
    );

    // Joining a group, even an empty one that could be given roles later.
    const ops = await authz.createGroup({ name: 'Operação' });
    await authz.setGroupRoles(ops.id, ['OPERATOR'], peer);
    await expect(authz.setGroupMembers(ops.id, [actor], actor)).rejects.toMatchObject(forbidden);
    const empty = await authz.createGroup({ name: 'Vazio' });
    await expect(authz.setGroupMembers(empty.id, [actor], actor)).rejects.toMatchObject(forbidden);

    // Once a member (added by someone else): no leaving, no role changes, no toggling, no delete.
    await authz.setGroupMembers(ops.id, [actor], peer);
    await expect(authz.setGroupMembers(ops.id, [], actor)).rejects.toMatchObject(forbidden);
    await expect(authz.setGroupRoles(ops.id, ['ADMIN'], actor)).rejects.toMatchObject(forbidden);
    await expect(authz.setGroupRoles(ops.id, [], actor)).rejects.toMatchObject(forbidden);
    await expect(authz.updateGroup(ops.id, { active: false }, actor)).rejects.toMatchObject(
      forbidden,
    );
    await expect(authz.deleteGroup(ops.id, actor)).rejects.toMatchObject(forbidden);
    // Managing other members of the same group does not touch the actor's grants.
    await authz.setGroupMembers(ops.id, [actor, bia], actor);
    await authz.updateGroup(ops.id, { name: 'Operação SP' }, actor);

    // A disabled group the actor belongs to cannot be re-enabled by them either.
    await authz.updateGroup(ops.id, { active: false }, peer);
    await expect(authz.updateGroup(ops.id, { active: true }, actor)).rejects.toMatchObject(
      forbidden,
    );

    // Permissions of a role the actor holds, directly or through a group.
    const direct = await authz.createRole({ key: 'DIRECT', name: 'Direto', permissions: [] }, peer);
    const viaGroup = await authz.createRole(
      { key: 'VIA_GROUP', name: 'Grupo', permissions: [] },
      peer,
    );
    await authz.setUserRoles(actor, ['ADMIN', 'DIRECT'], peer);
    await authz.updateGroup(ops.id, { active: true }, peer);
    await authz.setGroupRoles(ops.id, ['VIA_GROUP'], peer);
    for (const role of [direct, viaGroup]) {
      await expect(
        authz.updateRole(role.id, { permissions: ['DATA.DELETE'] }, actor),
      ).rejects.toMatchObject(forbidden);
      await expect(authz.deleteRole(role.id, actor)).rejects.toMatchObject(forbidden);
    }

    expect([...(await authz.effectivePermissions(actor))].sort()).toEqual(before);
    // The same changes are fine when someone else makes them.
    await authz.updateRole(direct.id, { permissions: ['AUDIT.READ'] }, peer);
    await authz.setGroupMembers(empty.id, [actor], peer);
  });

  it('serializes guarded changes with a transaction-scoped advisory lock', async () => {
    // Read pg_locks from inside the transaction: PGlite runs one transaction at a time, so a
    // second connection would wait for this one instead of observing it.
    const lockHeld = async (db: Pick<typeof database.db, 'execute'>) => {
      const res = await db.execute(
        sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and objid = ${GUARD_LOCK_KEY}`,
      );
      return Number((res as unknown as { rows: { n: number }[] }).rows[0]!.n);
    };
    let inside = -1;
    await authz.guarded(async (tx) => {
      inside = await lockHeld(tx);
    });
    expect(inside).toBe(1);
    expect(await lockHeld(database.db)).toBe(0);
  });

  it('keeps an administrator when two admins remove each other concurrently', async () => {
    const a = await newUser('a@example.com', ['ADMIN']);
    const b = await newUser('b@example.com', ['ADMIN']);
    const results = await Promise.allSettled([
      authz.setUserRoles(b, ['VIEWER'], a),
      authz.setUserRoles(a, ['VIEWER'], b),
      users.update(a, { active: false }, b),
      users.update(b, { active: false }, a),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(0);
    expect(await authz.activeHolders('ADMIN.USERS')).toBeGreaterThanOrEqual(1);
  });

  it('refuses resetting or reactivating an account with permissions the actor lacks', async () => {
    const forbidden = { code: 'FORBIDDEN' };
    const admin = await newUser('admin@example.com', ['ADMIN']);
    await authz.createRole(
      { key: 'USER_ADMIN', name: 'Cadastro', permissions: ['ADMIN.USERS'] },
      admin,
    );
    const clerk = await newUser('clerk@example.com', ['USER_ADMIN']);
    const second = await newUser('second@example.com', ['ADMIN']);
    const op = await newUser('op@example.com', ['OPERATOR']);
    const blank = await newUser('blank@example.com', []);

    // A weaker actor cannot take over a stronger account by resetting its password...
    await expect(users.resetPassword(admin, 'New!Strong#Pass12', clerk)).rejects.toMatchObject(
      forbidden,
    );
    // ...nor by reactivating a disabled one (deactivating is allowed: it grants nothing).
    await users.update(second, { active: false }, clerk);
    await expect(users.update(second, { active: true }, clerk)).rejects.toMatchObject(forbidden);
    expect((await users.findById(second))!.active).toBe(false);

    // No bypass for ADMIN: it lacks DATA.*, so an OPERATOR account is stronger in that respect.
    await expect(users.resetPassword(op, 'New!Strong#Pass12', admin)).rejects.toMatchObject(
      forbidden,
    );
    await users.update(op, { active: false }, admin);
    await expect(users.update(op, { active: true }, admin)).rejects.toMatchObject(forbidden);

    // Equal or weaker targets are fine.
    await users.resetPassword(blank, 'New!Strong#Pass12', clerk);
    await users.update(second, { active: true }, admin);
    await users.resetPassword(second, 'New!Strong#Pass12', admin);
    expect((await users.findById(second))!.mustChangePassword).toBe(true);
    await expect(
      users.resetPassword('00000000-0000-4000-8000-000000000000', 'New!Strong#Pass12', admin),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  describe("no granting beyond the actor's own permissions", () => {
    const forbidden = { code: 'FORBIDDEN' };
    /** A user holding every catalog permission, to set up state an ADMIN could not. */
    const newRoot = async () => {
      await seedRole('ALL', PERMISSIONS);
      return newUser('root@example.com', ['ALL']);
    };

    it('counts roles from disabled groups when guarding a password reset or reactivation', async () => {
      const root = await newRoot();
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const target = await newUser('target@example.com', []);
      const group = await authz.createGroup({ name: 'Dormente' });
      await authz.setGroupRoles(group.id, ['OPERATOR'], root);
      await authz.setGroupMembers(group.id, [target], root);
      await authz.updateGroup(group.id, { active: false }, root);
      // Effectively powerless, but OPERATOR comes back when the group is re-enabled.
      expect((await authz.effectivePermissions(target)).size).toBe(0);
      expect((await authz.latentGrants(target)).permissions.has('DATA.UPDATE')).toBe(true);

      await expect(users.resetPassword(target, 'New!Strong#Pass12', admin)).rejects.toMatchObject(
        forbidden,
      );
      await users.update(target, { active: false }, admin);
      await expect(users.update(target, { active: true }, admin)).rejects.toMatchObject(forbidden);
      await users.resetPassword(target, 'New!Strong#Pass12', root);
    });

    it('refuses assigning a user a role with permissions the actor lacks', async () => {
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const bia = await newUser('bia@example.com', ['VIEWER']);
      await expect(authz.setUserRoles(bia, ['VIEWER', 'OPERATOR'], admin)).rejects.toMatchObject(
        forbidden,
      );
      expect(await authz.directRoles(bia)).toEqual(['VIEWER']);
      // Roles the actor covers are fine, and so is removing them from a target they cover.
      await authz.setUserRoles(bia, ['ADMIN', 'VIEWER'], admin);
      await authz.setUserRoles(bia, ['VIEWER'], admin);
      const root = await newRoot();
      await authz.setUserRoles(bia, ['OPERATOR'], root);
      // Bia now holds DATA.* that the admin lacks: stripping her roles is refused too.
      await expect(authz.setUserRoles(bia, ['VIEWER'], admin)).rejects.toMatchObject(forbidden);
      await authz.setUserRoles(bia, ['VIEWER'], root);
    });

    it('refuses creating a user with roles the actor lacks', async () => {
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const input = { name: 'Op', password: PASSWORD, roles: ['OPERATOR'], createdBy: admin };
      await expect(users.create({ ...input, email: 'op@example.com' })).rejects.toMatchObject(
        forbidden,
      );
      expect(await users.findByEmail('op@example.com')).toBeUndefined();
      await users.create({ ...input, email: 'v@example.com', roles: ['VIEWER'] });
    });

    it('refuses giving a group a role with permissions the actor lacks', async () => {
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const group = await authz.createGroup({ name: 'Operação' });
      await expect(authz.setGroupRoles(group.id, ['OPERATOR'], admin)).rejects.toMatchObject(
        forbidden,
      );
      const root = await newRoot();
      await authz.setGroupRoles(group.id, ['OPERATOR', 'VIEWER'], root);
      await authz.setGroupRoles(group.id, ['VIEWER'], admin);
    });

    it('refuses adding members to a group that grants permissions the actor lacks', async () => {
      const root = await newRoot();
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const bia = await newUser('bia@example.com', []);
      const cid = await newUser('cid@example.com', []);
      const group = await authz.createGroup({ name: 'Operação' });
      await authz.setGroupRoles(group.id, ['OPERATOR'], root);
      // Disabled groups count too: their roles come back when the group is re-enabled.
      await authz.updateGroup(group.id, { active: false }, root);
      await expect(authz.setGroupMembers(group.id, [bia], admin)).rejects.toMatchObject(forbidden);
      await authz.setGroupMembers(group.id, [bia, cid], root);
      // Removing a member the admin does not cover (latent OPERATOR) is refused as well.
      await expect(authz.setGroupMembers(group.id, [cid], admin)).rejects.toMatchObject(forbidden);
      await authz.setGroupMembers(group.id, [cid], root);
    });

    it('refuses re-enabling a group that grants permissions the actor lacks', async () => {
      const root = await newRoot();
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const group = await authz.createGroup({ name: 'Operação' });
      await authz.setGroupRoles(group.id, ['OPERATOR'], root);
      await authz.updateGroup(group.id, { active: false }, admin);
      await expect(authz.updateGroup(group.id, { active: true }, admin)).rejects.toMatchObject(
        forbidden,
      );
      await authz.updateGroup(group.id, { active: true }, root);
    });

    it('refuses adding permissions the actor lacks to a role', async () => {
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const role = await authz.createRole(
        { key: 'AUDITOR', name: 'Auditor', permissions: ['AUDIT.READ', 'QUERY.SELECT'] },
        admin,
      );
      await expect(
        authz.updateRole(role.id, { permissions: ['AUDIT.READ', 'DATA.DELETE'] }, admin),
      ).rejects.toMatchObject(forbidden);
      expect((await authz.findRole(role.id)).permissions).toEqual(['AUDIT.READ', 'QUERY.SELECT']);
      await authz.updateRole(role.id, { permissions: ['AUDIT.READ', 'ADMIN.GROUPS'] }, admin);
    });

    it('refuses creating a role with permissions the actor lacks', async () => {
      const admin = await newUser('admin@example.com', ['ADMIN']);
      const input = { key: 'EDITOR', name: 'Editor' };
      await expect(
        authz.createRole({ ...input, permissions: ['QUERY.SELECT', 'DATA.UPDATE'] }, admin),
      ).rejects.toMatchObject({ ...forbidden, details: { missing: ['DATA.UPDATE'] } });
      expect((await authz.listRoles()).map((r) => r.key)).not.toContain('EDITOR');
      const created = await authz.createRole({ ...input, permissions: ['QUERY.SELECT'] }, admin);
      expect(created.permissions).toEqual(['QUERY.SELECT']);
    });
  });

  describe("no stripping an account stronger than the actor's", () => {
    const forbidden = { code: 'FORBIDDEN', details: { reason: 'stronger_account' } };

    /**
     * A: user administration plus reads. B: ADMIN plus DATA.*, directly and through a group.
     * Root holds everything, to set the scene and to show a covering actor is unaffected.
     */
    const scene = async () => {
      await seedRole('ALL', PERMISSIONS);
      const dataRole = await seedRole('DATA_ALL', ['DATA.INSERT', 'DATA.UPDATE', 'DATA.DELETE']);
      await seedRole('USER_ADMIN', ['ADMIN.USERS', 'ADMIN.ROLES', 'ADMIN.GROUPS', 'QUERY.SELECT']);
      const root = await newUser('root@example.com', ['ALL']);
      const a = await newUser('a@example.com', ['USER_ADMIN']);
      const b = await newUser('b@example.com', ['ADMIN', 'DATA_ALL']);
      const group = await authz.createGroup({ name: 'Dados' });
      await authz.setGroupRoles(group.id, ['DATA_ALL'], root);
      await authz.setGroupMembers(group.id, [b], root);
      return { root, a, b, group: group.id, dataRole };
    };

    /** The refusal names no user: neither id nor e-mail appear in the message or details. */
    const expectAnonymous = (err: unknown, b: string) => {
      const text = JSON.stringify({ m: (err as Error).message, d: (err as AppError).details });
      expect(text).not.toContain(b);
      expect(text).not.toContain('b@example.com');
    };

    it('refuses removing roles from a group with a stronger member', async () => {
      const { root, a, b, group } = await scene();
      const err = await authz.setGroupRoles(group, [], a).catch((e: unknown) => e);
      expect(err).toMatchObject(forbidden);
      expectAnonymous(err, b);
      expect((await authz.findGroup(group)).roleKeys).toEqual(['DATA_ALL']);
      await authz.setGroupRoles(group, [], root);
      expect((await authz.findGroup(group)).roleKeys).toEqual([]);
    });

    it('refuses removing permissions from a role a stronger user holds', async () => {
      const { root, a, b, dataRole } = await scene();
      const trimmed = { permissions: ['DATA.INSERT'] as Permission[] };
      const err = await authz.updateRole(dataRole, trimmed, a).catch((e: unknown) => e);
      expect(err).toMatchObject(forbidden);
      expectAnonymous(err, b);
      expect((await authz.findRole(dataRole)).permissions).toHaveLength(3);
      // Renaming removes nothing, so it stays allowed.
      await authz.updateRole(dataRole, { name: 'Dados' }, a);
      await authz.updateRole(dataRole, trimmed, root);
      expect((await authz.findRole(dataRole)).permissions).toEqual(['DATA.INSERT']);
    });

    it('refuses deleting a role a stronger user holds', async () => {
      const { root, a, b, dataRole } = await scene();
      const err = await authz.deleteRole(dataRole, a).catch((e: unknown) => e);
      expect(err).toMatchObject(forbidden);
      expectAnonymous(err, b);
      await authz.findRole(dataRole);
      await authz.deleteRole(dataRole, root);
      await expect(authz.findRole(dataRole)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it("refuses removing a stronger target's roles", async () => {
      const { a, b } = await scene();
      await expect(authz.setUserRoles(b, ['ADMIN'], a)).rejects.toMatchObject(forbidden);
      await expect(authz.setUserRoles(b, [], a)).rejects.toMatchObject(forbidden);
      // Swapping (adding a role the actor holds while removing another) is a removal too.
      await expect(authz.setUserRoles(b, ['ADMIN', 'USER_ADMIN'], a)).rejects.toMatchObject(
        forbidden,
      );
      expect(await authz.directRoles(b)).toEqual(['ADMIN', 'DATA_ALL']);
    });

    it('refuses removing a stronger target from a group, by membership edit or deletion', async () => {
      const { a, b, group } = await scene();
      await expect(authz.setGroupMembers(group, [], a)).rejects.toMatchObject(forbidden);
      await expect(authz.deleteGroup(group, a)).rejects.toMatchObject(forbidden);
      expect((await authz.findGroup(group)).memberIds).toEqual([b]);
    });

    it("still refuses resetting the stronger target's password", async () => {
      const { a, b } = await scene();
      await expect(authz.setUserRoles(b, [], a)).rejects.toMatchObject(forbidden);
      await expect(users.resetPassword(b, 'New!Strong#Pass12', a)).rejects.toMatchObject(forbidden);
      expect((await users.findById(b))!.mustChangePassword).toBe(false);
    });

    it('lets an actor covering the target remove roles and memberships', async () => {
      const { root, a, b, group } = await scene();
      await authz.setUserRoles(b, ['ADMIN'], root);
      await authz.setGroupMembers(group, [], root);
      expect(await authz.directRoles(b)).toEqual(['ADMIN']);
      expect((await authz.findGroup(group)).memberIds).toEqual([]);
      // A weaker target stays manageable by A, removals included.
      await seedRole('READER', ['QUERY.SELECT']);
      const reader = await newUser('r@example.com', ['READER']);
      await authz.setUserRoles(reader, [], a);
      expect(await authz.directRoles(reader)).toEqual([]);
    });
  });
});
