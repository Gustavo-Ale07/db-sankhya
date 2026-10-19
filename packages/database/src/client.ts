import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

export type Schema = typeof schema;
export type Database = PgDatabase<PgQueryResultHKT, Schema>;

export interface DatabaseHandle {
  db: Database;
  /** `postgres` in production; `pglite` (embedded) for development and tests. */
  kind: 'postgres' | 'pglite';
  ping(): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseOptions {
  /** Directory with the drizzle-kit generated SQL migrations. */
  migrationsDir?: string;
  /** Max pooled connections (postgres only). */
  poolSize?: number;
}

export function defaultMigrationsDir(): string {
  const fromEnv = process.env.MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  return fileURLToPath(new URL('../migrations', import.meta.url));
}

/**
 * Opens the database from a URL:
 *  - postgres://… / postgresql://… → node-postgres pool
 *  - pglite:memory or pglite:<dir> → embedded PGlite (never allowed in production; enforced by the API config)
 */
export async function createDatabase(
  url: string,
  options: DatabaseOptions = {},
): Promise<DatabaseHandle> {
  const migrationsFolder = options.migrationsDir ?? defaultMigrationsDir();
  if (url.startsWith('pglite:')) {
    const target = url.slice('pglite:'.length);
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const ephemeral = target === '' || target === 'memory';
    const client = ephemeral
      ? ((await restoreMigratedTemplate(migrationsFolder)) ?? new PGlite())
      : new PGlite(target);
    const db = drizzle(client, { schema });
    return {
      db: db as unknown as Database,
      kind: 'pglite',
      ping: async () => void (await db.execute(sql`select 1`)),
      migrate: () => migrate(db, { migrationsFolder: assertDir(migrationsFolder) }),
      close: () => client.close(),
    };
  }
  if (!/^postgres(ql)?:\/\//.test(url))
    throw new Error('DATABASE_URL must be a postgres:// URL (or pglite: for development)');
  const pg = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new pg.default.Pool({ connectionString: url, max: options.poolSize ?? 10 });
  const db = drizzle(pool, { schema });
  return {
    db: db as unknown as Database,
    kind: 'postgres',
    ping: async () => void (await pool.query('select 1')),
    migrate: () => migrate(db, { migrationsFolder: assertDir(migrationsFolder) }),
    close: () => pool.end(),
  };
}

function assertDir(dir: string): string {
  if (!existsSync(dir)) throw new Error(`Migrations directory not found: ${dir}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Test-only snapshot of a migrated in-memory PGlite.
//
// Booting PGlite and replaying every migration dominates integration test time.
// Under vitest only (NODE_ENV=test and VITEST set) and only for ephemeral
// instances, the first call migrates a fresh PGlite once per process and keeps
// its dumped data dir in memory; later calls load a private copy of it. Each
// restored instance owns its own data dir, so nothing mutable is shared. Any
// failure falls back to the regular fresh-and-migrate path.
// ---------------------------------------------------------------------------

const templateCache = new Map<string, Promise<Blob | File | null>>();
const stats = { builds: 0, restores: 0 };

/** Counters for the test snapshot path (exposed for tests). */
export function snapshotStats(): { builds: number; restores: number } {
  return { ...stats };
}

function snapshotEnabled(): boolean {
  return process.env.NODE_ENV === 'test' && Boolean(process.env.VITEST);
}

async function restoreMigratedTemplate(migrationsFolder: string) {
  if (!snapshotEnabled()) return null;
  try {
    const journal = readFileSync(join(migrationsFolder, 'meta', '_journal.json'));
    const key = `${migrationsFolder}:${createHash('sha256').update(journal).digest('hex')}`;
    let pending = templateCache.get(key);
    if (!pending) {
      pending = buildTemplate(migrationsFolder).catch(() => null);
      templateCache.set(key, pending);
    }
    const blob = await pending;
    if (!blob) {
      templateCache.delete(key);
      return null;
    }
    const { PGlite } = await import('@electric-sql/pglite');
    const restored = new PGlite({ loadDataDir: blob });
    await restored.waitReady;
    stats.restores += 1;
    return restored;
  } catch {
    return null;
  }
}

async function buildTemplate(migrationsFolder: string) {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const seed = new PGlite();
  try {
    await migrate(drizzle(seed, { schema }), { migrationsFolder: assertDir(migrationsFolder) });
    const blob = await seed.dumpDataDir('none');
    stats.builds += 1;
    return blob;
  } finally {
    await seed.close();
  }
}
