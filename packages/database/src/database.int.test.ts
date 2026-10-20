import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDatabase, defaultMigrationsDir } from './client';
import type { DatabaseHandle } from './client';
import { auditEvents, rolePermissions, roles, sessions, userRoles, users } from './schema';

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await createDatabase('pglite:memory');
  await handle.migrate();
});

afterAll(async () => {
  await handle.close();
});

describe('database', () => {
  it('applies migrations idempotently and answers ping', async () => {
    await handle.migrate();
    await expect(handle.ping()).resolves.toBeUndefined();
  });

  it('seeds DATA.PREVIEW on ADMIN and OPERATOR only, and re-running the seed is harmless', async () => {
    const holders = async () =>
      (
        await handle.db
          .select({ key: roles.key })
          .from(rolePermissions)
          .innerJoin(roles, eq(roles.id, rolePermissions.roleId))
          .where(eq(rolePermissions.permission, 'DATA.PREVIEW'))
      )
        .map((r) => r.key)
        .sort();
    expect(await holders()).toEqual(['ADMIN', 'OPERATOR']);
    const seed = readFileSync(join(defaultMigrationsDir(), '0012_data_preview.sql'), 'utf8');
    await handle.db.execute(sql.raw(seed));
    expect(await holders()).toEqual(['ADMIN', 'OPERATOR']);
  });

  it('enforces unique lower-case e-mails', async () => {
    const [u] = await handle.db
      .insert(users)
      .values({ email: 'admin@example.com', name: 'Admin', passwordHash: 'x' })
      .returning();
    expect(u?.active).toBe(true);
    await expect(
      handle.db
        .insert(users)
        .values({ email: 'admin@example.com', name: 'Dup', passwordHash: 'x' }),
    ).rejects.toThrow();
    await expect(
      handle.db.insert(users).values({ email: 'Upper@Example.com', name: 'U', passwordHash: 'x' }),
    ).rejects.toThrow();
  });

  it('seeds the system roles and validates role keys', async () => {
    const seeded = await handle.db.select().from(roles);
    expect(seeded.map((r) => r.key).sort()).toEqual(['ADMIN', 'OPERATOR', 'VIEWER']);
    expect(seeded.every((r) => r.system)).toBe(true);
    const admin = seeded.find((r) => r.key === 'ADMIN')!;
    const perms = await handle.db
      .select()
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, admin.id));
    expect(perms.map((p) => p.permission)).toContain('ADMIN.USERS');
    expect(perms.map((p) => p.permission)).not.toContain('DATA.UPDATE');
    await expect(handle.db.insert(roles).values({ key: 'lower', name: 'Bad' })).rejects.toThrow();
  });

  it('cascades sessions and keeps audit events', async () => {
    const [u] = await handle.db
      .insert(users)
      .values({ email: 'temp@example.com', name: 'Temp', passwordHash: 'x' })
      .returning();
    await handle.db
      .insert(sessions)
      .values({ tokenHash: 'h1', userId: u!.id, expiresAt: new Date(Date.now() + 1000) });
    await handle.db
      .insert(auditEvents)
      .values({ action: 'auth.login', status: 'success', userId: u!.id });
    await handle.db.delete(users).where(eq(users.id, u!.id));
    expect(await handle.db.select().from(sessions).where(eq(sessions.userId, u!.id))).toHaveLength(
      0,
    );
    expect(
      await handle.db.select().from(auditEvents).where(eq(auditEvents.userId, u!.id)),
    ).toHaveLength(1);
  });

  it('maps a legacy single role of existing users onto the seeded role', async () => {
    const full = defaultMigrationsDir();
    const partial = mkdtempSync(join(tmpdir(), 'dbx-mig-'));
    mkdirSync(join(partial, 'meta'));
    const journal = JSON.parse(readFileSync(join(full, 'meta', '_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    // Every migration before the RBAC one: the schema an existing installation upgrades from.
    const before = journal.entries.slice(
      0,
      journal.entries.findIndex((e) => e.tag.endsWith('_rbac')),
    );
    expect(before.length).toBeGreaterThan(0);
    for (const e of before) copyFileSync(join(full, `${e.tag}.sql`), join(partial, `${e.tag}.sql`));
    writeFileSync(
      join(partial, 'meta', '_journal.json'),
      JSON.stringify({ ...journal, entries: before }),
    );
    const legacy = await createDatabase('pglite:memory', { migrationsDir: partial });
    try {
      await legacy.migrate();
      await legacy.db.execute(
        sql`insert into users (email, name, password_hash, role) values
          ('v@example.com', 'V', 'x', 'VIEWER'),
          ('o@example.com', 'O', 'x', 'OPERATOR'),
          ('a@example.com', 'A', 'x', 'ADMIN')`,
      );
      // An in-memory database cannot be reopened, so run the remaining migrations on this handle.
      const { migrate } = await import('drizzle-orm/pglite/migrator');
      await migrate(legacy.db as never, { migrationsFolder: full });
      const rows = await legacy.db
        .select({ email: users.email, role: roles.key })
        .from(userRoles)
        .innerJoin(users, eq(users.id, userRoles.userId))
        .innerJoin(roles, eq(roles.id, userRoles.roleId));
      expect(rows.sort((x, y) => x.email.localeCompare(y.email))).toEqual([
        { email: 'a@example.com', role: 'ADMIN' },
        { email: 'o@example.com', role: 'OPERATOR' },
        { email: 'v@example.com', role: 'VIEWER' },
      ]);
    } finally {
      await legacy.close();
      rmSync(partial, { recursive: true, force: true });
    }
  });

  it('rejects non-postgres URLs', async () => {
    await expect(createDatabase('mysql://localhost/db')).rejects.toThrow(/postgres/);
  });
});
