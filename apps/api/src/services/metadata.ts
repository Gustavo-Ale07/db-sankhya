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
/** How long the metadata of one table, read on demand, is served before it is read again. */
export const TABLE_TTL_MS = 5 * 60 * 1000;

/**
 * A table name that may be inlined in a dictionary query: a plain identifier, so no quote or
 * operator can reach the SQL. Anything else is simply not a table of the connection.
 */
const TABLE_NAME = /^[A-Z_][A-Z0-9_$#]{0,127}$/;

const TABLES_SQL = 'SELECT NOMETAB, DESCRTAB FROM TDDTAB';
const FIELDS_SQL = 'SELECT NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM';
const ENTITIES_SQL = 'SELECT NOMETAB, NOMEINSTANCIA FROM TDDINS';

/** The dictionary reads of one table; `name` is a validated TABLE_NAME, never caller text. */
const tableSql = (name: string) => ({
  table: `${TABLES_SQL} WHERE NOMETAB = '${name}'`,
  fields: `${FIELDS_SQL} WHERE NOMETAB = '${name}'`,
  entities: `${ENTITIES_SQL} WHERE NOMETAB = '${name}'`,
});

/**
 * Primary key columns, from the database's own catalog (the data dictionary has no reliable
 * primary key listing). Table names are matched to the dictionary case-insensitively. With
 * `table` (a validated TABLE_NAME), only that table's keys are read.
 */
function pkSql(dialect: Dialect, table?: string): string {
  if (dialect === 'oracle') {
    return (
      'SELECT c.TABLE_NAME, cc.COLUMN_NAME FROM ALL_CONSTRAINTS c ' +
      'JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME ' +
      "WHERE c.CONSTRAINT_TYPE = 'P' AND c.OWNER = SYS_CONTEXT('USERENV','CURRENT_SCHEMA')" +
      (table ? ` AND UPPER(c.TABLE_NAME) = '${table}'` : '')
    );
  }
  return (
    'SELECT tc.TABLE_NAME, kcu.COLUMN_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ' +
    'JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA ' +
    'AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND kcu.TABLE_NAME = tc.TABLE_NAME ' +
    "WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = SCHEMA_NAME()" +
    (table ? ` AND UPPER(tc.TABLE_NAME) = '${table}'` : '')
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
  /** On-demand table metadata, keyed by connection and table (see tableKey). */
  private readonly tables = new Map<string, { table: CatalogTable; at: number }>();
  private readonly tablesInflight = new Map<string, Promise<CatalogTable | undefined>>();
  /** Bumped when a connection's tables are forgotten: a lookup started earlier is not kept. */
  private readonly tablesGeneration = new Map<string, number>();
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
    if (opts.refresh) this.forgetTables(connectionId);
    else {
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

  /**
   * The metadata of one table, read from the dictionary filtered by that table, so it never
   * depends on the whole-dictionary reads of `get`, which the gateway may cut at its row cap.
   * `undefined` when the connection has no such table. Fails closed: a failed or cut read throws
   * instead of answering fewer columns. Only describes the table; who may see or change which of
   * its columns is still decided by the policy engine.
   */
  async table(connectionId: string, name: string): Promise<CatalogTable | undefined> {
    const upper = name.toUpperCase();
    if (!TABLE_NAME.test(upper)) return undefined;
    const key = tableKey(connectionId, upper);
    const hit = this.tables.get(key);
    if (hit) {
      const age = this.now() - hit.at;
      if (age >= 0 && age < TABLE_TTL_MS) return hit.table;
      this.tables.delete(key);
    }
    let running = this.tablesInflight.get(key);
    if (!running) {
      const started = (running = this.discoverTable(connectionId, upper).finally(() => {
        if (this.tablesInflight.get(key) === started) this.tablesInflight.delete(key);
      }));
      this.tablesInflight.set(key, running);
    }
    return running;
  }

  /** Forgets the memory and persisted catalog of a connection (e.g. after its credentials change). */
  async invalidate(connectionId: string): Promise<void> {
    this.memory.delete(connectionId);
    this.forgetTables(connectionId);
    if (!this.persistable(connectionId)) return;
    try {
      await this.db.delete(metadataCache).where(eq(metadataCache.connectionId, connectionId));
    } catch {
      // The row, if any, is rediscovered once it expires.
    }
  }

  private forgetTables(connectionId: string): void {
    const prefix = tableKey(connectionId, '');
    for (const key of this.tables.keys()) if (key.startsWith(prefix)) this.tables.delete(key);
    for (const key of this.tablesInflight.keys()) {
      if (key.startsWith(prefix)) this.tablesInflight.delete(key);
    }
    this.tablesGeneration.set(connectionId, (this.tablesGeneration.get(connectionId) ?? 0) + 1);
  }

  private async discoverTable(
    connectionId: string,
    name: string,
  ): Promise<CatalogTable | undefined> {
    const generation = this.tablesGeneration.get(connectionId) ?? 0;
    const runtime = await this.deps.getRuntime(connectionId);
    const sql = tableSql(name);
    // Every read must be complete: a partial answer would pass for the whole table.
    const run = async (read: string, query: string): Promise<QueryResult> => {
      let result: QueryResult;
      try {
        result = await runtime.client.executeQuery(query);
      } catch (err) {
        throw tableUnreadable(name, `${read}:failed`, err);
      }
      if (result.truncated) throw tableUnreadable(name, `${read}:truncated`);
      return result;
    };

    const found = records(await run('TDDTAB', sql.table)).find((r) => text(r.NOMETAB) === name);
    if (!found) return undefined;
    const fields = await run('TDDCAM', sql.fields);
    const entities = await run('TDDINS', sql.entities);
    const keys = await run('PK', pkSql(runtime.dialect, name));

    const description = text(found.DESCRTAB);
    const entityName = records(entities)
      .filter((r) => text(r.NOMETAB) === name)
      .map((r) => text(r.NOMEINSTANCIA))
      .find(Boolean);
    const pks = new Set(
      records(keys)
        .filter((r) => text(r.TABLE_NAME).toUpperCase() === name)
        .map((r) => text(r.COLUMN_NAME).toUpperCase()),
    );
    const seen = new Set<string>();
    const columns: CatalogColumn[] = [];
    for (const row of records(fields)) {
      const column = text(row.NOMECAMPO);
      if (text(row.NOMETAB) !== name || !column || seen.has(column.toUpperCase())) continue;
      seen.add(column.toUpperCase());
      columns.push(catalogColumn(row, column, pks.has(column.toUpperCase())));
    }
    const table: CatalogTable = {
      name,
      ...(description ? { description } : {}),
      ...(entityName ? { entityName } : {}),
      columns,
      foreignKeys: [],
    };
    // A table without columns is answered but not kept: nothing about it can be confirmed. Nor is
    // one read before the connection was invalidated (its credentials may have changed since).
    const current = (this.tablesGeneration.get(connectionId) ?? 0) === generation;
    if (columns.length && current) {
      this.tables.set(tableKey(connectionId, name), { table, at: this.now() });
    }
    return table;
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
      table.columns.push(catalogColumn(row, name, pks.has(`${table.name}.${name}`.toUpperCase())));
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

function catalogColumn(row: Record<string, unknown>, name: string, pk: boolean): CatalogColumn {
  const description = text(row.DESCRCAMPO);
  return {
    name,
    type: FIELD_TYPES[text(row.TIPCAMPO).toUpperCase()] ?? 'unknown',
    ...(description ? { description } : {}),
    pk,
  };
}

/** Cache key of one table of one connection; neither part contains the separator. */
function tableKey(connectionId: string, table: string): string {
  return `${connectionId}\n${table}`;
}

function tableUnreadable(table: string, read: string, cause?: unknown): AppError {
  return new AppError(
    'SANKHYA_API_ERROR',
    `The data dictionary of ${table} could not be read completely`,
    { table, read },
    cause === undefined ? undefined : { cause },
  );
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
