import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { sessions, users } from '@dbx/database';
import type { Database, UserRow } from '@dbx/database';
import { AppError } from '@dbx/shared';
import type { Permission } from '@dbx/shared';
import { hashPassword } from '../security/crypto';
import type { AuthzService, Grants } from './authz';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  /** Effective roles: assigned directly or through an active group. */
  roles: string[];
  permissions: Permission[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export function toPublicUser(u: UserRow, grants: Grants): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    roles: grants.roles,
    permissions: [...grants.permissions].sort(),
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  };
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export class UsersService {
  constructor(
    private readonly db: Database,
    private readonly authz: AuthzService,
  ) {}

  async findByEmail(email: string): Promise<UserRow | undefined> {
    const [u] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);
    return u;
  }

  async findById(id: string): Promise<UserRow | undefined> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return u;
  }

  async list(): Promise<UserRow[]> {
    return this.db.select().from(users).orderBy(asc(users.email));
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(users);
    return row?.n ?? 0;
  }

  async create(input: {
    email: string;
    name: string;
    password: string;
    roles: readonly string[];
    mustChangePassword?: boolean;
    /** Acting user; they must hold every permission of the roles given. Unset for bootstrap. */
    createdBy?: string;
  }): Promise<UserRow> {
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.authz.guarded(async (tx) => {
        if (input.createdBy) await this.authz.assertCanGrantRoles(input.createdBy, input.roles, tx);
        const [u] = await tx
          .insert(users)
          .values({
            email: input.email.trim().toLowerCase(),
            name: input.name.trim(),
            passwordHash,
            mustChangePassword: input.mustChangePassword ?? false,
          })
          .returning();
        await this.authz.assignUserRoles(u!.id, input.roles, tx);
        return u as UserRow;
      }, input.createdBy);
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError('CONFLICT', 'A user with this e-mail already exists');
      throw err;
    }
  }

  /**
   * Status / name changes. Revokes the user's sessions when they are deactivated. Role changes
   * go through AuthzService and take effect on the next request.
   */
  async update(
    id: string,
    patch: { name?: string; active?: boolean },
    actorId: string,
  ): Promise<UserRow> {
    const current = await this.findById(id);
    if (!current) throw new AppError('NOT_FOUND', 'User not found');
    if (id === actorId && patch.active === false) {
      throw new AppError('CONFLICT', 'You cannot deactivate yourself');
    }
    const u = await this.authz.guarded(async (tx) => {
      // Reactivating an account lets whoever knows its password use it again.
      if (patch.active === true) {
        const [now] = await tx.select({ active: users.active }).from(users).where(eq(users.id, id));
        if (now && !now.active) await this.authz.assertCovers(actorId, id, tx);
      }
      const [row] = await tx
        .update(users)
        .set({
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.name ? { name: patch.name.trim() } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning();
      return row as UserRow;
    }, actorId);
    if (patch.active === false) await this.revokeSessions(id);
    return u;
  }

  /**
   * Administrative password reset. The actor learns the new password, so it is refused when the
   * target has any permission the actor lacks (no account takeover). The user must choose a new
   * password at the next login, and their sessions are revoked.
   */
  async resetPassword(id: string, password: string, actorId: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.authz.guarded(async (tx) => {
      await this.authz.assertCovers(actorId, id, tx);
      const result = await tx
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          passwordChangedAt: new Date(),
          failedLogins: 0,
          lockedUntil: null,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning({ id: users.id });
      if (result.length === 0) throw new AppError('NOT_FOUND', 'User not found');
    }, actorId);
    await this.revokeSessions(id);
  }

  async setPassword(id: string, password: string, mustChangePassword: boolean): Promise<void> {
    const result = await this.db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        mustChangePassword,
        passwordChangedAt: new Date(),
        failedLogins: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id))
      .returning({ id: users.id });
    if (result.length === 0) throw new AppError('NOT_FOUND', 'User not found');
  }

  async revokeSessions(userId: string, exceptSessionId?: string): Promise<void> {
    const conditions = [eq(sessions.userId, userId), sql`${sessions.revokedAt} is null`];
    if (exceptSessionId) conditions.push(ne(sessions.id, exceptSessionId));
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(...conditions));
  }

  /** Increments the failure counter atomically and locks the account at the threshold. */
  async recordLoginFailure(
    id: string,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<{ locked: boolean }> {
    const [row] = await this.db
      .update(users)
      .set({
        failedLogins: sql`${users.failedLogins} + 1`,
        lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${maxAttempts} then now() + (${lockMinutes} * interval '1 minute') else ${users.lockedUntil} end`,
      })
      .where(eq(users.id, id))
      .returning({ failedLogins: users.failedLogins });
    return { locked: (row?.failedLogins ?? 0) >= maxAttempts };
  }

  async recordLoginSuccess(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.id, id));
  }
}
