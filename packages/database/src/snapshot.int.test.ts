import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, defaultMigrationsDir, snapshotStats } from './client';
import type { DatabaseHandle } from './client';
import { users } from './schema';

type R = { rows: unknown[] };
const open: DatabaseHandle[] = [];
async function make(url = 'pglite:memory'): Promise<DatabaseHandle> {
  const h = await createDatabase(url);
  open.push(h);
  await h.ping();
  return h;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((h) => h.close()));
});

describe('migrated PGlite snapshot', () => {
  it('restores isolated instances from the cached template', async () => {
    await make(); // seeds the cache
    const before = snapshotStats().restores;
    const a = await make();
    const b = await make();
    expect(snapshotStats().restores).toBe(before + 2);
    await a.db.insert(users).values({ email: 'a@example.com', name: 'A', passwordHash: 'x' });
    const rowsA = await a.db.select().from(users);
    const rowsB = await b.db.select().from(users);
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(0);
  });

  it('has every table and the full journal applied; migrate() is a no-op', async () => {
    await make();
    const h = await make();
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsDir(), 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const applied = await h.db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(((applied as R).rows[0] as { n: number }).n).toBe(journal.entries.length);
    const tables = await h.db.execute(
      sql`select table_name from information_schema.tables where table_schema = 'public'`,
    );
    expect(((tables as R).rows as { table_name: string }[]).map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['users', 'roles', 'sessions', 'user_roles', 'role_permissions']),
    );
    await h.migrate();
    const again = await h.db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    expect(((again as R).rows[0] as { n: number }).n).toBe(journal.entries.length);
  });

  it('is not used outside test gating', async () => {
    await make(); // seed
    const before = snapshotStats();
    vi.stubEnv('NODE_ENV', 'production');
    const h = await make();
    await h.migrate();
    expect(snapshotStats()).toEqual(before);
    vi.unstubAllEnvs();
    vi.stubEnv('VITEST', '');
    await make();
    expect(snapshotStats()).toEqual(before);
  });
});
