/**
 * Materialization: copies the result of a Sankhya read into a scratch table, so it can be joined
 * with the user's own scratch data. The read goes through `executeRead` (token gate, AST
 * allowlist, catalog check, the caller's authorization decision, row cap) and the rows go
 * through `ScratchWorkspace.importRows` (table name rule, column rules and every workspace quota,
 * checked before COMMIT). Nothing here bypasses either path.
 */
import { AppError, isAppError } from '@dbx/shared';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type { Catalog } from './metadata';
import { executeRead } from './read-executor';
import type { PolicyDecision } from './read-executor';
import type { SankhyaRuntime } from './sankhya-runtime';
import type { ScratchColumnType, ScratchWorkspace } from './scratch';
import { assertScratchTableName } from './scratch-guard';

export interface MaterializeInput {
  runtime: SankhyaRuntime;
  workspace: ScratchWorkspace;
  /** A Sankhya read (SELECT); anything else is refused by executeRead. */
  sql: string;
  /** Target scratch table, `tmp_*`; an existing table of that name is replaced. */
  into: string;
  /** Rows copied at most (MATERIALIZE_MAX_ROWS); more rows are cut and reported as truncated. */
  maxRows: number;
  decide: (analysis: ReadAnalysis) => PolicyDecision;
  catalog: Catalog;
  signal: AbortSignal;
}

export interface MaterializeOutput {
  table: string;
  rows: number;
  truncated: boolean;
}

const MAX_COLUMN_NAME = 63;

export async function materialize(input: MaterializeInput): Promise<MaterializeOutput> {
  const { runtime, workspace, sql, into, maxRows, decide, catalog, signal } = input;
  // Validate the target first: a bad name must not cost a gateway call.
  assertScratchTableName(into);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new AppError('INTERNAL_ERROR', 'maxRows must be a positive integer');
  }

  const read = await executeRead({ runtime, catalog, sql, maxRows, signal, decide });
  throwIfAborted(signal);

  const names = columnNames(read.columns);
  const types = names.map((_n, i) => columnType(read.rows, i));
  const rows = read.rows.map((row) => names.map((_n, i) => cell(row[i], types[i]!)));
  await workspace.importRows(
    into,
    names.map((name, i) => ({ name, type: types[i]! })),
    rows,
    signal,
  );
  return { table: into, rows: rows.length, truncated: read.truncated };
}

/**
 * Scratch column names are lowercase identifiers. Gateway names are lowercased, other characters
 * become `_`, a leading digit gets a `c_` prefix, and duplicates get a numeric suffix.
 */
function columnNames(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((raw, i) => {
    let base = raw.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (base === '' || /^_*$/.test(base)) base = `col_${i + 1}`;
    if (/^[0-9]/.test(base)) base = `c_${base}`;
    base = base.slice(0, MAX_COLUMN_NAME);
    let name = base;
    for (let n = 2; used.has(name); n += 1) {
      const suffix = `_${n}`;
      name = `${base.slice(0, MAX_COLUMN_NAME - suffix.length)}${suffix}`;
    }
    used.add(name);
    return name;
  });
}

/** numeric or boolean when every non-null value is one; text otherwise. */
function columnType(rows: unknown[][], index: number): ScratchColumnType {
  let numeric = true;
  let boolean = true;
  for (const row of rows) {
    const v = row[index];
    if (v === null || v === undefined) continue;
    if (!(typeof v === 'number' && Number.isFinite(v)) && typeof v !== 'bigint') numeric = false;
    if (typeof v !== 'boolean') boolean = false;
    if (!numeric && !boolean) return 'text';
  }
  if (numeric) return 'numeric';
  return boolean ? 'boolean' : 'text';
}

function cell(value: unknown, type: ScratchColumnType): unknown {
  if (value === null || value === undefined) return null;
  if (type === 'numeric' && typeof value === 'bigint') return value.toString();
  if (type !== 'text') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  const reason: unknown = signal.reason;
  throw isAppError(reason) ? reason : new AppError('QUERY_CANCELLED', 'The query was cancelled');
}
