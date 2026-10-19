import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { SQLWrapper } from 'drizzle-orm';
import {
  groupMembers,
  groupRoles,
  groups,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@dbx/database';
import type { Database, GroupRow, RoleRow } from '@dbx/database';
import { AppError, isPermission } from '@dbx/shared';
import type { Permission } from '@dbx/shared';

/** Permission that keeps the tool administrable; some active user must always hold it. */
export const KEEPER_PERMISSION: Permission = 'ADMIN.USERS';

/**
 * Key of the transaction-scoped advisory lock taken by every guarded change. It serializes them,
 * so two concurrent changes cannot each see another holder of the keeper permission and both
 * remove it.
 */
export const GUARD_LOCK_KEY = 81_000_001;

/** Nobody changes their own effective permissions, through any path. */
export function selfChangeError(): AppError {
  return new AppError('FORBIDDEN', 'You cannot change your own permissions', {
    reason: 'self_change',
  });
}

function sameGrants(a: Grants, b: Grants): boolean {
  return (
    a.roles.join('\n') === b.roles.join('\n') &&
    a.permissions.size === b.permissions.size &&
    [...a.permissions].every((p) => b.permissions.has(p))
  );
}

export interface Grants {
  /** Keys of the roles the user holds directly or through an active group, sorted. */
  roles: string[];
  permissions: ReadonlySet<Permission>;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  permissions: Permission[];
}

export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  memberIds: string[];
  roleKeys: string[];
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type Db = Database | Tx;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Ids of the roles a user holds directly or through an active group. With `includeInactive`, the
 * roles of disabled groups count too (what the user would get if those groups were re-enabled).
 */
function roleIdsOf(userId: string | SQLWrapper, includeInactive = false) {
  return sql`(
    select ${userRoles.roleId} from ${userRoles} where ${userRoles.userId} = ${userId}
    union
    select ${groupRoles.roleId} from ${groupRoles}
      join ${groupMembers} on ${groupMembers.groupId} = ${groupRoles.groupId}
      join ${groups} on ${groups.id} = ${groupRoles.groupId}
    where ${groupMembers.userId} = ${userId} and (${groups.active} or ${includeInactive})
  )`;
}

/**
 * Resolves effective permissions (union of the user's roles and the roles of their active
 * groups) and administers roles and groups. Unknown permission strings are ignored: the
 * catalog is the only source of meaning, so anything else fails closed.
 */
export class AuthzService {
  constructor(private readonly db: Database) {}

  async grants(userId: string, db: Db = this.db): Promise<Grants> {
    return this.grantsOf(userId, false, db);
  }

  /**
   * Roles and permissions the user has directly or through any of their groups, active or not.
   * A disabled group can be re-enabled, so its roles still count when judging how strong an
   * account is.
   */
  async latentGrants(userId: string, db: Db = this.db): Promise<Grants> {
    return this.grantsOf(userId, true, db);
  }

  private async grantsOf(userId: string, includeInactive: boolean, db: Db): Promise<Grants> {
    const rows = await db
      .select({ key: roles.key, permission: rolePermissions.permission })
      .from(roles)
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(sql`${roles.id} in ${roleIdsOf(userId, includeInactive)}`);
    const keys = new Set<string>();
    const permissions = new Set<Permission>();
    for (const r of rows) {
      keys.add(r.key);
      if (r.permission && isPermission(r.permission)) permissions.add(r.permission);
    }
    return { roles: [...keys].sort(), permissions };
  }

  async effectivePermissions(userId: string): Promise<ReadonlySet<Permission>> {
    return (await this.grants(userId)).permissions;
  }

  /** Ids of the active groups the user belongs to (policy rules can target groups). */
  async activeGroupIds(userId: string, db: Db = this.db): Promise<string[]> {
    const rows = await db
      .select({ id: groups.id })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groups.active, true)))
      .orderBy(asc(groups.id));
    return rows.map((r) => r.id);
  }

  /** Keys of the roles assigned directly to the user (not through groups). */
  async directRoles(userId: string, db: Db = this.db): Promise<string[]> {
    const rows = await db
      .select({ key: roles.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, userId))
      .orderBy(asc(roles.key));
    return rows.map((r) => r.key);
  }

  /** Number of active users holding `permission`. */
  async activeHolders(permission: Permission, db: Db = this.db): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(users)
      .where(
        and(
          eq(users.active, true),
          sql`exists (select 1 from ${rolePermissions} where ${rolePermissions.permission} = ${permission} and ${rolePermissions.roleId} in ${roleIdsOf(users.id)})`,
        ),
      );
    return row?.n ?? 0;
  }

  /**
   * Runs a change in a transaction, serialized with every other guarded change by an advisory
   * lock. Refuses it when it would change the actor's own roles or permissions, or leave no
   * active user with the administration permission.
   */
  async guarded<T>(change: (tx: Tx) => Promise<T>, actorId?: string): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${GUARD_LOCK_KEY})`);
      const before = await this.activeHolders(KEEPER_PERMISSION, tx);
      const mine = actorId ? await this.grants(actorId, tx) : null;
      const result = await change(tx);
      if (actorId && mine && !sameGrants(mine, await this.grants(actorId, tx))) {
        throw selfChangeError();
      }
      if (before > 0 && (await this.activeHolders(KEEPER_PERMISSION, tx)) === 0) {
        throw new AppError(
          'CONFLICT',
          `At least one active user must keep the ${KEEPER_PERMISSION} permission`,
        );
      }
      return result;
    });
  }

  private async roleIdsByKey(keys: readonly string[], db: Db): Promise<string[]> {
    const unique = [...new Set(keys)];
    if (unique.length === 0) return [];
    const rows = await db
      .select({ id: roles.id, key: roles.key })
      .from(roles)
      .where(inArray(roles.key, unique));
    if (rows.length !== unique.length) {
      const found = new Set(rows.map((r) => r.key));
      throw new AppError('VALIDATION_ERROR', 'Unknown role', {
        roles: unique.filter((k) => !found.has(k)),
      });
    }
    return rows.map((r) => r.id);
  }

  /** Replaces the roles assigned directly to a user. Used on creation as well. */
  async assignUserRoles(userId: string, roleKeys: readonly string[], db: Db): Promise<void> {
    const ids = await this.roleIdsByKey(roleKeys, db);
    await db.delete(userRoles).where(eq(userRoles.userId, userId));
    if (ids.length > 0)
      await db.insert(userRoles).values(ids.map((roleId) => ({ userId, roleId })));
  }

  /**
   * Changes a user's direct roles. Nobody changes their own roles. Removing a role needs an actor
   * who covers the target as they are before the change: otherwise stripping a stronger account
   * would make it weak enough for a password reset (account takeover).
   */
  async setUserRoles(userId: string, roleKeys: readonly string[], actorId: string): Promise<void> {
    if (userId === actorId) throw selfChangeError();
    const [u] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!u) throw new AppError('NOT_FOUND', 'User not found');
    await this.guarded(async (tx) => {
      const current = await tx
        .select({ id: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, userId));
      const kept = new Set(await this.roleIdsByKey(roleKeys, tx));
      if (current.some((r) => !kept.has(r.id))) await this.assertCovers(actorId, userId, tx);
      const added = await this.addedRoleIds(roleKeys, current, tx);
      await this.assertCanGrant(actorId, await this.permissionsOfRoles(added, tx), tx);
      await this.assignUserRoles(userId, roleKeys, tx);
    }, actorId);
  }

  /** Refuses roles carrying permissions the actor lacks. Used when a user is created. */
  async assertCanGrantRoles(actorId: string, roleKeys: readonly string[], db: Db): Promise<void> {
    const ids = await this.roleIdsByKey(roleKeys, db);
    await this.assertCanGrant(actorId, await this.permissionsOfRoles(ids, db), db);
  }

  /**
   * Nobody grants a permission they do not hold themselves (effective). There is no exception
   * for ADMIN. Removals from a user are guarded by `assertCovers` instead.
   */
  private async assertCanGrant(
    actorId: string,
    granted: Iterable<Permission>,
    db: Db,
  ): Promise<void> {
    const mine = (await this.grants(actorId, db)).permissions;
    const missing = [...new Set(granted)].filter((p) => !mine.has(p)).sort();
    if (missing.length > 0) {
      throw new AppError('FORBIDDEN', 'You cannot grant permissions you do not hold', {
        reason: 'beyond_own',
        missing,
      });
    }
  }

  private async addedRoleIds(
    roleKeys: readonly string[],
    current: { id: string }[],
    db: Db,
  ): Promise<string[]> {
    const have = new Set(current.map((r) => r.id));
    return (await this.roleIdsByKey(roleKeys, db)).filter((id) => !have.has(id));
  }

  private async permissionsOfRoles(roleIds: readonly string[], db: Db): Promise<Set<Permission>> {
    if (roleIds.length === 0) return new Set();
    const rows = await db
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, [...roleIds]));
    return new Set(rows.map((r) => r.permission).filter(isPermission));
  }

  /** Every permission the group's roles grant, whether the group is active or not. */
  private async groupPermissions(groupId: string, db: Db): Promise<Set<Permission>> {
    const rows = await db
      .select({ id: groupRoles.roleId })
      .from(groupRoles)
      .where(eq(groupRoles.groupId, groupId));
    return this.permissionsOfRoles(
      rows.map((r) => r.id),
      db,
    );
  }

  /**
   * Refuses when the target holds a permission the actor lacks. Used before any change that would
   * let the actor sign in as the target (password reset, reactivation) and before removing roles
   * or group memberships from the target, which could otherwise weaken it until it passes this
   * check. There is no exception for ADMIN: an ADMIN lacks DATA.*, so an OPERATOR account counts
   * as stronger in that respect.
   */
  async assertCovers(actorId: string, targetId: string, db: Db): Promise<void> {
    const mine = await this.grants(actorId, db);
    const theirs = await this.latentGrants(targetId, db);
    const missing = [...theirs.permissions].filter((p) => !mine.permissions.has(p)).sort();
    if (missing.length > 0) {
      throw new AppError(
        'FORBIDDEN',
        'You cannot take over an account that has permissions you do not hold',
        { reason: 'stronger_account', missing },
      );
    }
  }

  /** Refuses unless the actor covers every given user (same error as the single-user check). */
  private async assertCoversAll(actorId: string, userIds: Iterable<string>, db: Db) {
    for (const id of new Set(userIds)) await this.assertCovers(actorId, id, db);
  }

  /** Users holding the role directly or through any group, active or not. */
  private async holdersOfRole(roleId: string, db: Db): Promise<string[]> {
    const direct = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));
    const viaGroup = await db
      .select({ userId: groupMembers.userId })
      .from(groupRoles)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groupRoles.groupId))
      .where(eq(groupRoles.roleId, roleId));
    return [...direct, ...viaGroup].map((r) => r.userId);
  }

  private async membersOf(groupId: string, db: Db): Promise<string[]> {
    const rows = await db
      .select({ userId: groupMembers.userId })
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    return rows.map((r) => r.userId);
  }

  private async isMember(groupId: string, userId: string, db: Db): Promise<boolean> {
    const [row] = await db
      .select({ n: count() })
      .from(groupMembers)
      .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)));
    return (row?.n ?? 0) > 0;
  }

  /** Whether the user holds the role directly or through any group, active or not. */
  private async holdsRole(roleId: string, userId: string, db: Db): Promise<boolean> {
    const [direct] = await db
      .select({ n: count() })
      .from(userRoles)
      .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)));
    if ((direct?.n ?? 0) > 0) return true;
    const [viaGroup] = await db
      .select({ n: count() })
      .from(groupRoles)
      .innerJoin(groupMembers, eq(groupMembers.groupId, groupRoles.groupId))
      .where(and(eq(groupMembers.userId, userId), eq(groupRoles.roleId, roleId)));
    return (viaGroup?.n ?? 0) > 0;
  }

  // ---- roles -------------------------------------------------------------------------------

  async listRoles(): Promise<RoleView[]> {
    const rows = await this.db.select().from(roles).orderBy(asc(roles.key));
    const perms = await this.db.select().from(rolePermissions);
    return rows.map((r) => this.roleView(r, perms));
  }

  private roleView(r: RoleRow, perms: { roleId: string; permission: string }[]): RoleView {
    return {
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      system: r.system,
      permissions: perms
        .filter((p) => p.roleId === r.id)
        .map((p) => p.permission)
        .filter(isPermission)
        .sort(),
    };
  }

  private async getRole(id: string, db: Db = this.db): Promise<RoleRow> {
    const [r] = await db.select().from(roles).where(eq(roles.id, id));
    if (!r) throw new AppError('NOT_FOUND', 'Role not found');
    return r;
  }

  async findRole(id: string): Promise<RoleView> {
    const r = await this.getRole(id);
    const perms = await this.db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, id));
    return this.roleView(r, perms);
  }

  /** Nobody creates a role carrying permissions they do not hold themselves. */
  async createRole(
    input: {
      key: string;
      name: string;
      description?: string | null;
      permissions: Permission[];
    },
    actorId: string,
  ): Promise<RoleView> {
    try {
      const id = await this.db.transaction(async (tx) => {
        await this.assertCanGrant(actorId, input.permissions, tx);
        const [r] = await tx
          .insert(roles)
          .values({
            key: input.key,
            name: input.name.trim(),
            description: input.description ?? null,
            system: false,
          })
          .returning({ id: roles.id });
        await this.writePermissions(r!.id, input.permissions, tx);
        return r!.id;
      });
      return this.findRole(id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', 'A role with this key exists');
      throw err;
    }
  }

  /**
   * System roles are fixed: their permissions are part of the security model. Nobody edits the
   * permissions of a role they hold.
   */
  async updateRole(
    id: string,
    patch: { name?: string; description?: string | null; permissions?: Permission[] },
    actorId: string,
  ): Promise<RoleView> {
    const current = await this.getRole(id);
    if (current.system && patch.permissions)
      throw new AppError('CONFLICT', 'The permissions of a system role cannot be changed');
    await this.guarded(async (tx) => {
      if (patch.permissions) {
        if (await this.holdsRole(id, actorId, tx)) throw selfChangeError();
        const before = await this.permissionsOfRoles([id], tx);
        const after = new Set(patch.permissions);
        if ([...before].some((p) => !after.has(p)))
          await this.assertCoversAll(actorId, await this.holdersOfRole(id, tx), tx);
        const added = patch.permissions.filter((p) => !before.has(p));
        await this.assertCanGrant(actorId, added, tx);
      }
      await tx
        .update(roles)
        .set({
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.description !== undefined ? { description: patch.description } : {}),
          updatedAt: new Date(),
        })
        .where(eq(roles.id, id));
      if (patch.permissions) await this.writePermissions(id, patch.permissions, tx);
    }, actorId);
    return this.findRole(id);
  }

  async deleteRole(id: string, actorId: string): Promise<void> {
    const current = await this.getRole(id);
    if (current.system) throw new AppError('CONFLICT', 'System roles cannot be deleted');
    await this.guarded(async (tx) => {
      if (await this.holdsRole(id, actorId, tx)) throw selfChangeError();
      await this.assertCoversAll(actorId, await this.holdersOfRole(id, tx), tx);
      await tx.delete(roles).where(eq(roles.id, id));
    }, actorId);
  }

  private async writePermissions(roleId: string, permissions: Permission[], db: Db) {
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    const unique = [...new Set(permissions)];
    if (unique.length > 0)
      await db.insert(rolePermissions).values(unique.map((permission) => ({ roleId, permission })));
  }

  // ---- groups ------------------------------------------------------------------------------

  async listGroups(): Promise<GroupView[]> {
    const rows = await this.db.select().from(groups).orderBy(asc(groups.name));
    const members = await this.db.select().from(groupMembers);
    const assigned = await this.db
      .select({ groupId: groupRoles.groupId, key: roles.key })
      .from(groupRoles)
      .innerJoin(roles, eq(roles.id, groupRoles.roleId));
    return rows.map((g) => this.groupView(g, members, assigned));
  }

  private groupView(
    g: GroupRow,
    members: { groupId: string; userId: string }[],
    assigned: { groupId: string; key: string }[],
  ): GroupView {
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      active: g.active,
      memberIds: members.filter((m) => m.groupId === g.id).map((m) => m.userId),
      roleKeys: assigned
        .filter((a) => a.groupId === g.id)
        .map((a) => a.key)
        .sort(),
    };
  }

  async findGroup(id: string): Promise<GroupView> {
    const [g] = await this.db.select().from(groups).where(eq(groups.id, id));
    if (!g) throw new AppError('NOT_FOUND', 'Group not found');
    const members = await this.db.select().from(groupMembers).where(eq(groupMembers.groupId, id));
    const assigned = await this.db
      .select({ groupId: groupRoles.groupId, key: roles.key })
      .from(groupRoles)
      .innerJoin(roles, eq(roles.id, groupRoles.roleId))
      .where(eq(groupRoles.groupId, id));
    return this.groupView(g, members, assigned);
  }

  async createGroup(input: { name: string; description?: string | null }): Promise<GroupView> {
    try {
      const [g] = await this.db
        .insert(groups)
        .values({ name: input.name.trim(), description: input.description ?? null })
        .returning({ id: groups.id });
      return this.findGroup(g!.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', 'A group with this name exists');
      throw err;
    }
  }

  /** Members cannot enable or disable their own group; renaming it is fine. */
  async updateGroup(
    id: string,
    patch: { name?: string; description?: string | null; active?: boolean },
    actorId: string,
  ): Promise<GroupView> {
    const current = await this.findGroup(id);
    try {
      await this.guarded(async (tx) => {
        const toggles = patch.active !== undefined && patch.active !== current.active;
        if (toggles && (await this.isMember(id, actorId, tx))) throw selfChangeError();
        if (toggles && patch.active)
          await this.assertCanGrant(actorId, await this.groupPermissions(id, tx), tx);
        await tx
          .update(groups)
          .set({
            ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
            ...(patch.description !== undefined ? { description: patch.description } : {}),
            ...(patch.active !== undefined ? { active: patch.active } : {}),
            updatedAt: new Date(),
          })
          .where(eq(groups.id, id));
      }, actorId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', 'A group with this name exists');
      throw err;
    }
    return this.findGroup(id);
  }

  /** Deleting a group removes every member from it, so the actor must cover each of them. */
  async deleteGroup(id: string, actorId: string): Promise<void> {
    await this.findGroup(id);
    await this.guarded(async (tx) => {
      if (await this.isMember(id, actorId, tx)) throw selfChangeError();
      await this.assertCoversAll(actorId, await this.membersOf(id, tx), tx);
      await tx.delete(groups).where(eq(groups.id, id));
    }, actorId);
  }

  /**
   * Replaces the members. Nobody adds or removes themselves. Removing a member needs an actor who
   * covers that member as they are before the change (see `setUserRoles`).
   */
  async setGroupMembers(
    id: string,
    userIds: readonly string[],
    actorId: string,
  ): Promise<GroupView> {
    await this.findGroup(id);
    const unique = [...new Set(userIds)];
    if (unique.length > 0) {
      const found = await this.db
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.id, unique));
      if (found.length !== unique.length) throw new AppError('VALIDATION_ERROR', 'Unknown user');
    }
    await this.guarded(async (tx) => {
      if ((await this.isMember(id, actorId, tx)) !== unique.includes(actorId))
        throw selfChangeError();
      const current = await tx
        .select({ userId: groupMembers.userId })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, id));
      const had = new Set(current.map((m) => m.userId));
      const keeps = new Set(unique);
      for (const m of current)
        if (!keeps.has(m.userId)) await this.assertCovers(actorId, m.userId, tx);
      if (unique.some((u) => !had.has(u)))
        await this.assertCanGrant(actorId, await this.groupPermissions(id, tx), tx);
      await tx.delete(groupMembers).where(eq(groupMembers.groupId, id));
      if (unique.length > 0)
        await tx.insert(groupMembers).values(unique.map((userId) => ({ groupId: id, userId })));
    }, actorId);
    return this.findGroup(id);
  }

  /** Replaces the roles of a group. Members cannot change the roles of their own group. */
  async setGroupRoles(
    id: string,
    roleKeys: readonly string[],
    actorId: string,
  ): Promise<GroupView> {
    await this.findGroup(id);
    await this.guarded(async (tx) => {
      if (await this.isMember(id, actorId, tx)) throw selfChangeError();
      const current = await tx
        .select({ id: groupRoles.roleId })
        .from(groupRoles)
        .where(eq(groupRoles.groupId, id));
      const ids = await this.roleIdsByKey(roleKeys, tx);
      const kept = new Set(ids);
      if (current.some((r) => !kept.has(r.id)))
        await this.assertCoversAll(actorId, await this.membersOf(id, tx), tx);
      const added = await this.addedRoleIds(roleKeys, current, tx);
      await this.assertCanGrant(actorId, await this.permissionsOfRoles(added, tx), tx);
      await tx.delete(groupRoles).where(eq(groupRoles.groupId, id));
      if (ids.length > 0)
        await tx.insert(groupRoles).values(ids.map((roleId) => ({ groupId: id, roleId })));
    }, actorId);
    return this.findGroup(id);
  }

  /** Groups a user belongs to (ids), for the admin view. */
  async groupsOf(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return rows.map((r) => r.id);
  }
}
