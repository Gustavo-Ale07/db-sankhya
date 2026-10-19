import { existsSync } from 'node:fs';
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
    const client = target === '' || target === 'memory' ? new PGlite() : new PGlite(target);
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
