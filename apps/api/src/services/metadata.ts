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
  /** The first instance of the table in TDDINS, by name. */
  entityName?: string;
  /**
   * Every instance TDDINS lists for the table, sorted by name. With more than one, which of them
   * a write goes through cannot be guessed and writes refuse the table (see mutations).
   */
  entityNames?: string[];
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
  /** How long a degraded catalog is served before it is read again (DEGRADED_TTL_MS). */
  degradedTtlMs?: number;
  /** At most this many pages of one dictionary read (MAX_FIELD_PAGES). */
  maxPages?: number;
}

/** How long a discovered catalog is served before the dictionary is read again. */
export const METADATA_TTL_MS = 60 * 60 * 1000;
/**
 * A degraded catalog is kept in memory only, and is read again after this long (by default; see
 * METADATA_DEGRADED_TTL_SECONDS). Until it is as old as a whole one may be, it is still served
 * while that read runs behind it.
 */
export const DEGRADED_TTL_MS = 10 * 60 * 1000;
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
const ENTITIES_ORDER = ' ORDER BY NOMETAB, NOMEINSTANCIA';

/** The row count a dictionary read is checked against (the gateway may cut it silently). */
const countSql = (from: string) => `SELECT COUNT(*) AS TOTAL FROM ${from}`;

/**
 * A dictionary read one page at a time, each page starting right after the last key of the one
 * before (see readPaged).
 */
interface PagedRead {
  /** Names the read in `degraded`, e.g. `TDDCAM`. */
  label: string;
  /** The page after `after`, the last key of the page before, which `inlinable` accepted. */
  page(after?: string): string;
  key(row: Record<string, unknown>): string;
  /** Whether the keys of a page are in strict order after `after`, where that can be checked. */
  ordered(keys: string[], after: string | undefined): boolean;
  /** Whether a key may be inlined in the SQL of the next page. */
  inlinable(key: string): boolean;
  count: string;
}

const SAFE_KEY = /^\d{1,15}$/;

/**
 * TDDCAM by its numeric key: the whole dictionary outgrows the gateway row cap. A number compares
 * the same way in every database and collation (a name may not), so the order can be checked.
 */
const FIELDS_READ: PagedRead = {
  label: 'TDDCAM',
  page: (after) =>
    'SELECT NUCAMPO, NOMETAB, NOMECAMPO, DESCRCAMPO, TIPCAMPO FROM TDDCAM' +
    (after === undefined ? '' : ` WHERE NUCAMPO > ${after}`) +
    ' ORDER BY NUCAMPO',
  key: (r) => text(r.NUCAMPO),
  ordered: (keys, after) =>
    keys.every((k, i) => {
      const prev = i ? keys[i - 1]! : after;
      return SAFE_KEY.test(k) && (prev === undefined || Number(k) > Number(prev));
    }),
  inlinable: (key) => SAFE_KEY.test(key),
  count: countSql('TDDCAM'),
};

/**
 * TDDTAB by name. The database orders and compares the names with the same collation, so a page
 * starting after the last name carries on where the one before stopped; the order itself cannot
 * be checked here, but a name read twice or a total that does not add up still shows a cut.
 */
const TABLES_READ: PagedRead = {
  label: 'TDDTAB',
  page: (after) =>
    TABLES_SQL + (after === undefined ? '' : ` WHERE NOMETAB > '${after}'`) + ' ORDER BY NOMETAB',
  key: (r) => text(r.NOMETAB),
  ordered: () => true,
  inlinable: (key) => TABLE_NAME.test(key),
  count: countSql('TDDTAB'),
};

/** Default of METADATA_MAX_PAGES: pages of one dictionary read; a bigger one is reported as cut. */
export const MAX_FIELD_PAGES = 100;

/** The dictionary reads of one table; `name` is a validated TABLE_NAME, never caller text. */
const tableSql = (name: string) => ({
  table: `${TABLES_SQL} WHERE NOMETAB = '${name}'`,
  fields: `${FIELDS_SQL} WHERE NOMETAB = '${name}'`,
  fieldsCount: countSql(`TDDCAM WHERE NOMETAB = '${name}'`),
  entities: `${ENTITIES_SQL} WHERE NOMETAB = '${name}' ORDER BY NOMEINSTANCIA`,
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

/** A key of the primary key read: `TABLE.COLUMN`, both plain database names. */
const PK_KEY = /^([A-Za-z0-9_$#]{1,128})\.([A-Za-z0-9_$#]{1,128})$/;

/**
 * The primary key columns of every table, by table and column name: a big schema outgrows the
 * gateway row cap. As with TDDTAB, the database orders and compares the names with the same
 * collation, so the order is not checked here; a key read twice or a total that does not add up
 * still shows a cut.
 */
function pkRead(dialect: Dialect): PagedRead {
  const keys = `(${pkSql(dialect)}) K`;
  return {
    label: 'PK',
    page: (after) => {
      const [, table, column] = (after !== undefined && PK_KEY.exec(after)) || [];
      return (
        `SELECT K.TABLE_NAME, K.COLUMN_NAME FROM ${keys}` +
        (table === undefined
          ? ''
          : ` WHERE K.TABLE_NAME > '${table}' OR (K.TABLE_NAME = '${table}' AND K.COLUMN_NAME > '${column}')`) +
        ' ORDER BY K.TABLE_NAME, K.COLUMN_NAME'
      );
    },
    key: (r) => {
      const table = text(r.TABLE_NAME);
      const column = text(r.COLUMN_NAME);
      return table && column ? `${table}.${column}` : '';
    },
    ordered: () => true,
    inlinable: (key) => PK_KEY.test(key),
    count: countSql(keys),
  };
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
  /**
   * Bumped when what is known of a connection is forgotten (invalidate, refresh): a discovery or
   * lookup started earlier still answers its caller but is not kept.
   */
  private readonly generation = new Map<string, number>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly degradedTtlMs: number;
  private readonly maxPages: number;

  constructor(
    private readonly db: Database,
    private readonly deps: MetadataDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? METADATA_TTL_MS;
    this.degradedTtlMs = deps.degradedTtlMs ?? DEGRADED_TTL_MS;
    this.maxPages = deps.maxPages ?? MAX_FIELD_PAGES;
  }

  async get(connectionId: string, opts: { refresh?: boolean } = {}): Promise<Catalog> {
    if (opts.refresh) this.forget(connectionId);
    // A lookup that began before an invalidation may answer its caller but keeps nothing.
    const generation = this.generationOf(connectionId);
    if (!opts.refresh) {
      const cached = await this.cached(connectionId, generation);
      if (cached) return cached;
      // A degraded catalog past its short life is still answered at once while it is read again
      // behind it, until it is as old as a whole catalog may be.
      const stale = this.memory.get(connectionId);
      if (stale?.degraded?.length && this.age(stale) < this.ttlMs) {
        this.discovery(connectionId, generation).catch(() => undefined);
        return stale;
      }
    }
    return this.discovery(connectionId, generation);
  }

  /** The discovery of a connection; concurrent callers share one. */
  private discovery(connectionId: string, generation: number): Promise<Catalog> {
    // Begun before an invalidation: runs alone, so no later caller joins what will not be kept.
    if (generation !== this.generationOf(connectionId))
      return this.discover(connectionId, generation);
    let running = this.inflight.get(connectionId);
    if (!running) {
      const started = (running = this.discover(connectionId, generation).finally(() => {
        if (this.inflight.get(connectionId) === started) this.inflight.delete(connectionId);
      }));
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

  /**
   * Forgets the memory and persisted catalog of a connection, and its tables (called when the
   * connection, its secrets or its existence change). A discovery or lookup still running is not
   * kept, nor joined by later callers.
   */
  async invalidate(connectionId: string): Promise<void> {
    this.memory.delete(connectionId);
    this.forget(connectionId);
    await this.unstore(connectionId);
  }

  /** Forgets the tables and the running reads of a connection (see `generation`). */
  private forget(connectionId: string): void {
    const prefix = tableKey(connectionId, '');
    for (const key of this.tables.keys()) if (key.startsWith(prefix)) this.tables.delete(key);
    for (const key of this.tablesInflight.keys()) {
      if (key.startsWith(prefix)) this.tablesInflight.delete(key);
    }
    this.inflight.delete(connectionId);
    this.generation.set(connectionId, this.generationOf(connectionId) + 1);
  }

  private generationOf(connectionId: string): number {
    return this.generation.get(connectionId) ?? 0;
  }

  private async discoverTable(
    connectionId: string,
    name: string,
  ): Promise<CatalogTable | undefined> {
    const generation = this.generationOf(connectionId);
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
    // Checked against its count: a gateway may cut a read without flagging it.
    if (totalOf(await run('TDDCAM', sql.fieldsCount)) !== fields.rows.length)
      throw tableUnreadable(name, 'TDDCAM:truncated');
    const entities = await run('TDDINS', sql.entities);
    const keys = await run('PK', pkSql(runtime.dialect, name));

    const description = text(found.DESCRTAB);
    const instances = instancesOf(records(entities).filter((r) => text(r.NOMETAB) === name));
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
      ...instances,
      columns,
      foreignKeys: [],
    };
    // A table without columns is answered but not kept: nothing about it can be confirmed. Nor is
    // one read before the connection was invalidated (its credentials may have changed since).
    if (columns.length && this.generationOf(connectionId) === generation) {
      this.tables.set(tableKey(connectionId, name), { table, at: this.now() });
    }
    return table;
  }

  /** Age of a catalog in milliseconds; a catalog from the future counts as expired. */
  private age(catalog: Catalog): number {
    const age = this.now() - Date.parse(catalog.fetchedAt);
    return age >= 0 ? age : Infinity;
  }

  private fresh(catalog: Catalog): boolean {
    return this.age(catalog) < (catalog.degraded?.length ? this.degradedTtlMs : this.ttlMs);
  }

  private async cached(connectionId: string, generation: number): Promise<Catalog | undefined> {
    const hit = this.memory.get(connectionId);
    if (hit && this.fresh(hit)) return hit;
    const stored = await this.load(connectionId);
    if (stored && this.fresh(stored) && this.generationOf(connectionId) === generation) {
      this.memory.set(connectionId, stored);
      return stored;
    }
    return undefined;
  }

  private async discover(connectionId: string, generation: number): Promise<Catalog> {
    const runtime = await this.deps.getRuntime(connectionId);
    const run = (sql: string) => runtime.client.executeQuery(sql);

    const degraded: string[] = [];
    // Every read is checked against its own count: a gateway may cut a result at its row cap
    // without flagging it. A read that does not add up is kept but marks the catalog degraded.
    const checked = async (label: string, result: QueryResult, count: string) => {
      if (result.truncated || (await countOf(run, count)) !== result.rows.length)
        degraded.push(`${label}:truncated`);
      return result;
    };
    const read = async (label: string, sql: string, count: string) => {
      const result = await optional(() => run(sql));
      if (!result) degraded.push(`${label}:failed`);
      return result && checked(label, result, count);
    };
    let tablesResult: QueryResult;
    try {
      tablesResult =
        (await readPaged(run, degraded, TABLES_READ, this.maxPages)) ??
        (await checked('TDDTAB', await run(TABLES_SQL), TABLES_READ.count));
    } catch (err) {
      throw new AppError(
        'SANKHYA_API_ERROR',
        'The Sankhya data dictionary could not be read',
        undefined,
        { cause: err },
      );
    }
    // The remaining reads only add detail; losing one must not fail the catalog.
    const fields =
      (await readPaged(run, degraded, FIELDS_READ, this.maxPages).catch(() => undefined)) ??
      (await read('TDDCAM', FIELDS_SQL, FIELDS_READ.count));
    const entities = await read('TDDINS', ENTITIES_SQL + ENTITIES_ORDER, countSql('TDDINS'));
    const pk = pkRead(runtime.dialect);
    const keys =
      (await readPaged(run, degraded, pk, this.maxPages).catch(() => undefined)) ??
      (await read('PK', pkSql(runtime.dialect), pk.count));

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
    const byTable = new Map<string, Array<Record<string, unknown>>>();
    for (const row of records(entities)) {
      const name = text(row.NOMETAB);
      byTable.set(name, [...(byTable.get(name) ?? []), row]);
    }
    for (const [name, rows] of byTable) {
      const table = tables.get(name);
      if (table) Object.assign(table, instancesOf(rows));
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
    // Read before the connection was invalidated: answered, never kept (its secrets or settings
    // may have changed since).
    if (this.generationOf(connectionId) !== generation) return catalog;
    this.memory.set(connectionId, catalog);
    if (!degraded.length) {
      await this.store(connectionId, catalog);
      // Invalidated while it was being stored: the row may have landed after the delete.
      if (this.generationOf(connectionId) !== generation) {
        if (this.memory.get(connectionId) === catalog) this.memory.delete(connectionId);
        await this.unstore(connectionId);
      }
    }
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

  private async unstore(connectionId: string): Promise<void> {
    if (!this.persistable(connectionId)) return;
    try {
      await this.db.delete(metadataCache).where(eq(metadataCache.connectionId, connectionId));
    } catch {
      // The row, if any, is rediscovered once it expires.
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

/**
 * A dictionary read in pages (see PagedRead), so it holds every row even when the whole read
 * outgrows the gateway row cap and the catalog is cached for the full TTL. The rows are taken as
 * whole only when they add up to the read's own count: a page that was not flagged as cut may
 * still have been cut silently, and the next page then carries on after it. A page that fails,
 * repeats a key, comes back out of order or with other columns ends the read, which is then
 * reported as failed or cut (and the tables it lost are read on their own where it matters, see
 * `table`). `undefined` when the first page cannot be paged (its keys are missing or out of
 * order): the caller falls back to the single read. The first page's failure is thrown.
 */
async function readPaged(
  run: (sql: string) => Promise<QueryResult>,
  degraded: string[],
  read: PagedRead,
  maxPages: number,
): Promise<QueryResult | undefined> {
  let columns: string[] = [];
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  let total: number | undefined | null = null;
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = page ? await optional(() => run(read.page(after))) : await run(read.page());
    if (!result) {
      degraded.push(`${read.label}:failed`);
      return { columns, rows, truncated: false };
    }
    const keys = records(result).map(read.key);
    const usable =
      keys.every((k) => k && !seen.has(k)) &&
      new Set(keys).size === keys.length &&
      read.ordered(keys, after);
    if (page === 0 && !usable) return undefined;
    if (!usable || (page > 0 && !sameColumns(columns, result.columns))) break;
    columns = result.columns;
    rows.push(...result.rows);
    for (const k of keys) seen.add(k);
    if (!result.truncated) {
      total ??= await countOf(run, read.count);
      if (total === rows.length) return { columns, rows, truncated: false };
      // Fewer rows than counted: the page may have been cut silently, so read on after it.
      if (total === undefined || total < rows.length || !keys.length) break;
    }
    const last = keys.at(-1);
    if (last === undefined || !read.inlinable(last)) break;
    after = last;
  }
  degraded.push(`${read.label}:truncated`);
  return { columns, rows, truncated: true };
}

/** The `TOTAL` of a count read, `undefined` when it failed or is not a count. */
async function countOf(
  run: (sql: string) => Promise<QueryResult>,
  sql: string,
): Promise<number | undefined> {
  return totalOf(await optional(() => run(sql)));
}

function totalOf(result: QueryResult | undefined): number | undefined {
  const rows = records(result);
  const total = Number(text(rows[0]?.TOTAL));
  return rows.length === 1 && Number.isSafeInteger(total) ? total : undefined;
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

/** `entityName` and `entityNames` of a table from its TDDINS rows, in name order whatever their order. */
function instancesOf(
  rows: Array<Record<string, unknown>>,
): Pick<CatalogTable, 'entityName' | 'entityNames'> {
  const names = [...new Set(rows.map((r) => text(r.NOMEINSTANCIA)).filter(Boolean))].sort();
  return names.length ? { entityName: names[0]!, entityNames: names } : {};
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c.toUpperCase() === b[i]!.toUpperCase());
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
