import { eq } from 'drizzle-orm';
import { metadataCache } from '@dbx/database';
import type { Database } from '@dbx/database';
import type { QueryResult } from '@dbx/sankhya-client';
import { AppError } from '@dbx/shared';
import { ENV_CONNECTION_ID } from './connections';
import type { Dialect, SankhyaRuntime } from './sankhya-runtime';

export interface CatalogColumn {
  name: string;
  type: string;
  description?: string;
  /** Not discovered today (the dictionary reads carry no nullability), so never set. */
  nullable?: boolean;
  pk: boolean;
}

export interface CatalogForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface CatalogTable {
  name: string;
  description?: string;
  entityName?: string;
  columns: CatalogColumn[];
  /** Only foreign keys the dictionary exposes; none are discovered today, so this is empty. */
  foreignKeys: CatalogForeignKey[];
}

export interface Catalog {
  tables: CatalogTable[];
  /** ISO-8601 instant at which the dictionary was read. */
  fetchedAt: string;
  source: 'dictionary';
  /**
   * Present when some read failed or was cut at the gateway row cap, e.g. `TDDCAM:failed`,
   * `TDDTAB:truncated`, `PK:failed`. The catalog is then incomplete and is only cached briefly.
   */
  degraded?: string[];
}

export interface MetadataDeps {
  /** Resolves the runtime (gateway client) of a connection. */
  getRuntime(connectionId: string): Promise<SankhyaRuntime>;
  /** Clock in epoch milliseconds; tests inject a fake one. */
  now?: () => number;
  ttlMs?: number;
}

/** How long a discovered catalog is served before the dictionary is read again. */
export const METADATA_TTL_MS = 60 * 60 * 1000;
/** A degraded catalog is kept in memory only, and only this long. */
export const DEGRADED_TTL_MS = 60 * 1000;

const TABLES_SQL = 'SELECT NOMETAB, DESCRTAB FROM TDDTAB';
const FIELDS_SQL = 'SELECT NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM';
const ENTITIES_SQL = 'SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS';

/**
 * Primary key columns, from the database's own catalog (the data dictionary has no reliable
 * primary key listing). Table names are matched to the dictionary case-insensitively.
 */
function pkSql(dialect: Dialect): string {
  if (dialect === 'oracle') {
    return (
      'SELECT c.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONSTRAINTS c ' +
      'JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME ' +
      "WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA')"
    );
  }
  return (
    'SELECT tc.TABLE_NAME, kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ' +
    'JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA ' +
    'AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME ' +
    "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = SCHEMA_NAME()"
  );
}

/** Dictionary field type codes (TIPCAMPO) mapped to the names the explorer shows. */
const FIELD_TYPES: Record<string, string> = {
  I: 'integer',
  S: 'string',
  F: 'decimal',
  D: 'date',
  H: 'datetime',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the Sankhya data dictionary (TDDTAB, TDDCAM, TDDINS) and the database's primary key
 * catalog of a connection and keeps the
 * resulting catalog for an hour: in memory, and in `metadata_cache` so a restart does not pay for
 * discovery again. Only the table list is mandatory; every other read degrades to less detail and
 * marks the catalog `degraded`, which is then neither persisted nor kept for long.
 */
export class MetadataService {
  private readonly memory = new Map<string, Catalog>();
  private readonly inflight = new Map<string, Promise<Catalog>>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(
    private readonly db: Database,
    private readonly deps: MetadataDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? METADATA_TTL_MS;
  }

  async get(connectionId: string, opts: { refresh?: boolean } = {}): Promise<Catalog> {
    if (!opts.refresh) {
      const cached = await this.cached(connectionId);
      if (cached) return cached;
    }
    // Concurrent callers share one discovery; a refresh also joins one already running.
    let running = this.inflight.get(connectionId);
    if (!running) {
      running = this.discover(connectionId).finally(() => this.inflight.delete(connectionId));
      this.inflight.set(connectionId, running);
    }
    return running;
  }

  /** Forgets the memory and persisted catalog of a connection (e.g. after its credentials change). */
  async invalidate(connectionId: string): Promise<void> {
    this.memory.delete(connectionId);
    if (!this.persistable(connectionId)) return;
    try {
      await this.db.delete(metadataCache).where(eq(metadataCache.connectionId, connectionId));
    } catch {
      // The row, if any, is rediscovered once it expires.
    }
  }

  private fresh(catalog: Catalog): boolean {
    const age = this.now() - Date.parse(catalog.fetchedAt);
    return age >= 0 && age < (catalog.degraded?.length ? DEGRADED_TTL_MS : this.ttlMs);
  }

  private async cached(connectionId: string): Promise<Catalog | undefined> {
    const hit = this.memory.get(connectionId);
    if (hit && this.fresh(hit)) return hit;
    const stored = await this.load(connectionId);
    if (stored && this.fresh(stored)) {
      this.memory.set(connectionId, stored);
      return stored;
    }
    return undefined;
  }

  private async discover(connectionId: string): Promise<Catalog> {
    const runtime = await this.deps.getRuntime(connectionId);
    const run = (sql: string) => runtime.client.executeQuery(sql);

    const degraded: string[] = [];
    let tablesResult: QueryResult;
    try {
      tablesResult = await run(TABLES_SQL);
    } catch (err) {
      throw new AppError(
        'SANKHYA_API_ERROR',
        'The Sankhya data dictionary could not be read',
        undefined,
        { cause: err },
      );
    }
    // The remaining reads only add detail; losing one must not fail the catalog.
    if (tablesResult.truncated) degraded.push('TDDTAB:truncated');
    const read = async (label: string, sql: string) => {
      const result = await optional(() => run(sql));
      if (!result) degraded.push(`${label}:failed`);
      else if (result.truncated) degraded.push(`${label}:truncated`);
      return result;
    };
    const fields = await read('TDDCAM', FIELDS_SQL);
    const entities = await read('TDDINS', ENTITIES_SQL);
    const keys = await read('PK', pkSql(runtime.dialect));

    const tables = new Map<string, CatalogTable>();
    for (const row of records(tablesResult)) {
      const name = text(row.NOMETAB);
      if (!name || tables.has(name)) continue;
      const description = text(row.DESCRTAB);
      tables.set(name, {
        name,
        ...(description ? { description } : {}),
        columns: [],
        foreignKeys: [],
      });
    }
    for (const row of records(entities)) {
      const table = tables.get(text(row.NOMETAB));
      const entityName = text(row.NOMEINSTANCIA);
      if (table && entityName && !table.entityName) table.entityName = entityName;
    }
    const pks = new Set<string>();
    for (const row of records(keys))
      pks.add(`${text(row.TABLE_NAME).toUpperCase()}.${text(row.COLUMN_NAME).toUpperCase()}`);
    for (const row of records(fields)) {
      const table = tables.get(text(row.NOMETAB));
      const name = text(row.NOMECAMPO);
      if (!table || !name) continue;
      const description = text(row.DESCRCAMPO);
      table.columns.push({
        name,
        type: FIELD_TYPES[text(row.TIPCAMPO).toUpperCase()] ?? 'unknown',
        ...(description ? { description } : {}),
        pk: pks.has(`${table.name}.${name}`.toUpperCase()),
      });
    }

    const catalog: Catalog = {
      tables: [...tables.values()].sort((a, b) => a.name.localeCompare(b.name)),
      fetchedAt: new Date(this.now()).toISOString(),
      source: 'dictionary',
      ...(degraded.length ? { degraded } : {}),
    };
    this.memory.set(connectionId, catalog);
    if (!degraded.length) await this.store(connectionId, catalog);
    return catalog;
  }

  // Persistence is an optimisation: the env connection has no row to hang a cache entry on, and
  // a database hiccup must never fail a lookup that already succeeded against the gateway.
  private persistable(connectionId: string): boolean {
    return connectionId !== ENV_CONNECTION_ID && UUID.test(connectionId);
  }

  private async load(connectionId: string): Promise<Catalog | undefined> {
    if (!this.persistable(connectionId)) return undefined;
    try {
      const [row] = await this.db
        .select()
        .from(metadataCache)
        .where(eq(metadataCache.connectionId, connectionId));
      return row && isCatalog(row.payload) ? row.payload : undefined;
    } catch {
      return undefined;
    }
  }

  private async store(connectionId: string, catalog: Catalog): Promise<void> {
    if (!this.persistable(connectionId)) return;
    const fetchedAt = new Date(catalog.fetchedAt);
    try {
      await this.db
        .insert(metadataCache)
        .values({ connectionId, payload: catalog, fetchedAt })
        .onConflictDoUpdate({
          target: metadataCache.connectionId,
          set: { payload: catalog, fetchedAt },
        });
    } catch {
      // Not cached; the next lookup rediscovers.
    }
  }
}

async function optional(read: () => Promise<QueryResult>): Promise<QueryResult | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** Rows keyed by upper-cased column name; columns the gateway did not return are just absent. */
function records(result: QueryResult | undefined): Array<Record<string, unknown>> {
  if (!result) return [];
  const names = result.columns.map((c) => c.toUpperCase());
  return result.rows.map((row) => {
    const rec: Record<string, unknown> = {};
    names.forEach((n, i) => (rec[n] = row[i]));
    return rec;
  });
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function isCatalog(value: unknown): value is Catalog {
  const v = value as Partial<Catalog> | null;
  return (
    typeof v === 'object' &&
    v !== null &&
    v.source === 'dictionary' &&
    typeof v.fetchedAt === 'string' &&
    Array.isArray(v.tables) &&
    v.tables.every(
      (t) =>
        typeof t?.name === 'string' && Array.isArray(t.columns) && Array.isArray(t.foreignKeys),
    )
  );
}
