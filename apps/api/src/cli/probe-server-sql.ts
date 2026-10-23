/**
 * READ-ONLY probe for the server-side route ("Executa Banco" / SERVER_SQL).
 *
 * It confirms, against a real connection, only the facts the already-authorized read service
 * (DbExplorerSP.executeQuery) can prove:
 *   - the control entity (default AD_MANIPULADADOS) exists and is readable;
 *   - it has the key column (ID) and the script column (TEXTO), with their types;
 *   - how many rows it currently holds (a sanity read).
 *
 * It does NOT confirm the action-98 binding: which action id runs the block, and whether it
 * reads it from TEXTO of the pointed record. That is not discoverable from a plain SELECT on a
 * known dictionary table here, so it stays a documented pendency (see docs/server-sql.md) unless
 * you pass a SELECT you trust with --action-sql.
 *
 * SAFETY: this command never writes. Every statement it sends is checked to be a single SELECT
 * (no ';', no second statement). It never prints credentials — only query results. It uses the
 * same connection loading, decryption and SSRF guard as the running app; nothing new talks to the
 * gateway.
 *
 *   probe-server-sql [--connection <id|name>] [--entity AD_MANIPULADADOS] [--action 98]
 *                    [--action-sql "SELECT ... (a read you trust, to inspect the action binding)"]
 *
 * --connection defaults to the env-default connection (the SANKHYA_* variables). Development:
 * `pnpm --filter @dbx/api probe-server-sql [...]`.
 */
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createDatabase } from '@dbx/database';
import type { DatabaseHandle } from '@dbx/database';
import { isAppError } from '@dbx/shared';
import { ConfigError, loadConfig } from '../config';
import type { AppConfig } from '../config';
import { ConnectionsService, ENV_CONNECTION_ID } from '../services/connections';
import type { Dialect } from '../services/sankhya-runtime';

export interface ProbeCliDeps {
  config: AppConfig;
  database: DatabaseHandle;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `Usage:
  probe-server-sql [--connection <id|name>] [--entity <NAME>] [--action <id>]
                   [--action-sql "<a SELECT you trust>"]

Read-only. Confirms the control entity (default AD_MANIPULADADOS) exists and has ID and TEXTO,
through DbExplorerSP.executeQuery on the chosen connection (default: the env-default connection).
It never writes and never prints credentials. The action-<id> binding is NOT probed unless you
pass --action-sql with a SELECT you trust.
`;

/** Plain, uppercase ERP identifier — what we are willing to interpolate into a SELECT literal. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Fails unless `sql` is a single SELECT statement (no second statement, no trailing ';'). */
export function assertSelectOnly(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (/;/.test(trimmed)) throw new Error('only a single statement is allowed (no ";")');
  if (!/^(select|with)\b/i.test(trimmed))
    throw new Error('only a SELECT/WITH statement is allowed');
}

function columnsSql(dialect: Dialect, entity: string): string {
  return dialect === 'mssql'
    ? `SELECT TABLE_SCHEMA AS OWNER, COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH AS DATA_LENGTH, IS_NULLABLE AS NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${entity}' ORDER BY ORDINAL_POSITION`
    : `SELECT OWNER, COLUMN_NAME, DATA_TYPE, DATA_LENGTH, NULLABLE FROM ALL_TAB_COLUMNS WHERE TABLE_NAME = '${entity}' ORDER BY OWNER, COLUMN_ID`;
}

function renderTable(columns: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  const widths = columns.map((c, i) =>
    Math.max(c.length, ...rows.map((r) => cell(r[i]).length), 0),
  );
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  const out = [line(columns), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(columns.map((_, i) => cell(r[i]))));
  return out.join('\n');
}

/** Runs one command; returns the process exit code (0 ok, 1 failed, 2 usage error). */
export async function runProbeCli(argv: readonly string[], deps: ProbeCliDeps): Promise<number> {
  const { config, database, stdout, stderr } = deps;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        connection: { type: 'string' },
        entity: { type: 'string' },
        action: { type: 'string' },
        'action-sql': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    stderr(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values } = parsed;
  if (values.help) {
    stderr(USAGE);
    return 0;
  }

  const entity = (values.entity ?? 'AD_MANIPULADADOS').trim().toUpperCase();
  if (!IDENTIFIER.test(entity)) {
    stderr(`--entity must be a plain table name (letters, digits, underscore), got "${entity}"\n`);
    return 2;
  }
  const actionId = (values.action ?? '98').trim();

  const connections = new ConnectionsService(database.db, config);
  try {
    // Resolve --connection (id or name) to an id; default to the env-default connection.
    let connectionId = (values.connection ?? ENV_CONNECTION_ID).trim();
    const list = await connections.list();
    if (!list.some((c) => c.id === connectionId)) {
      const byName = list.filter((c) => c.name === connectionId);
      if (byName.length === 1) connectionId = byName[0]!.id;
      else if (byName.length > 1) {
        stderr(
          `More than one connection is named "${connectionId}"; pass its id with --connection\n`,
        );
        return 1;
      } else {
        stderr(
          `No connection "${connectionId}". Known: ${list.map((c) => `${c.name} (${c.id})`).join(', ') || '(none)'}\n`,
        );
        return 1;
      }
    }
    const chosen = list.find((c) => c.id === connectionId)!;
    stderr(
      `Probing connection "${chosen.name}" [${chosen.environment} / ${chosen.dialect} / ${chosen.mode}] — read only.\n\n`,
    );

    const runtime = await connections.getRuntime(connectionId);
    const run = async (label: string, sql: string) => {
      assertSelectOnly(sql);
      stderr(`• ${label}\n`);
      const r = await runtime.client.executeQuery(
        sql,
        AbortSignal.timeout(config.sankhya.timeoutMs),
      );
      return r;
    };

    // 1) Columns of the control entity.
    const cols = await run(`columns of ${entity}`, columnsSql(runtime.dialect, entity));
    if (cols.rows.length === 0) {
      stdout(
        `\nFAIL: ${entity} is not visible to this connection's user (no columns returned).\n` +
          `The integration user needs read access to ${entity} for the server route to work.\n`,
      );
      return 1;
    }
    stdout(`\n${entity} columns:\n${renderTable(cols.columns, cols.rows)}\n`);

    const nameIdx = cols.columns.findIndex((c) => c.toUpperCase() === 'COLUMN_NAME');
    const names = new Set(
      cols.rows.map((r) => String(r[nameIdx] ?? '').toUpperCase()).filter(Boolean),
    );
    const hasId = names.has('ID');
    const hasTexto = names.has('TEXTO');

    // 2) Row count (a plain read proves the table is queryable, not just catalogued).
    let rowCount = '?';
    try {
      const count = await run(`row count of ${entity}`, `SELECT COUNT(*) AS N FROM ${entity}`);
      rowCount = String(count.rows[0]?.[0] ?? '?');
    } catch (err) {
      rowCount = `(could not read: ${isAppError(err) ? err.code : 'error'})`;
    }

    // 3) Action binding: not provable from a plain SELECT here. Optionally run a trusted read.
    if (values['action-sql']) {
      try {
        const act = await run('action binding (--action-sql)', values['action-sql']);
        stdout(`\naction-sql result:\n${renderTable(act.columns, act.rows)}\n`);
      } catch (err) {
        stdout(
          `\naction-sql failed: ${isAppError(err) ? `${err.code} ${err.message}` : String(err)}\n`,
        );
      }
    }

    stdout(
      `\nSummary for ${entity} on "${chosen.name}" (${chosen.environment}):\n` +
        `  ID column (key):    ${hasId ? 'present ✓' : 'MISSING ✗'}\n` +
        `  TEXTO column (block): ${hasTexto ? 'present ✓' : 'MISSING ✗'}\n` +
        `  rows currently:     ${rowCount}\n` +
        `\nNOT confirmed by this probe (still a pendency — see docs/server-sql.md):\n` +
        `  - that action id ${actionId} runs the block, and reads it from TEXTO of the pointed record;\n` +
        `  - the executeJava envelope the gateway expects for action ${actionId}.\n` +
        `  Confirm these from a captured real "Executa Banco" call or the consultoria's DBScript docs.\n` +
        (hasId && hasTexto
          ? `\nThe read side of the control entity checks out. Writes (save/executeJava/removeRecords)\n` +
            `remain to be authorized at Sankhya and proven in homologation.\n`
          : `\nThe control entity is missing a required column; do not run the server route against it.\n`),
    );
    return hasId && hasTexto ? 0 : 1;
  } catch (err) {
    if (isAppError(err)) {
      stderr(`${err.code}: ${err.message}\n`);
      return 1;
    }
    stderr(`${err instanceof Error ? err.message : 'unknown error'}\n`);
    return 1;
  } finally {
    await connections.close();
  }
}

async function main(): Promise<number> {
  let config: AppConfig;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
  const bundled = fileURLToPath(new URL('./migrations', import.meta.url));
  const migrationsDir = config.migrationsDir ?? (existsSync(bundled) ? bundled : undefined);
  const database = await createDatabase(config.databaseUrl, migrationsDir ? { migrationsDir } : {});
  try {
    await database.migrate();
    return await runProbeCli(process.argv.slice(2), {
      config,
      database,
      stdout: (s) => void process.stdout.write(s),
      stderr: (s) => void process.stderr.write(s),
    });
  } finally {
    await database.close();
  }
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      pathToFileURL(realpathSync(entry)).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(
        `probe-server-sql: ${err instanceof Error ? err.message : 'unknown error'}\n`,
      );
      process.exit(1);
    },
  );
}
