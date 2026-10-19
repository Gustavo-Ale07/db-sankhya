import { AppError, isAppError } from '@dbx/shared';
import { analyzeRead, tokenGate } from '@dbx/sql-engine';
import type { ReadAnalysis } from '@dbx/sql-engine';
import type { Catalog } from './metadata';
import type { SankhyaRuntime } from './sankhya-runtime';

/**
 * Outcome of the authorization check of a read. Minimal on purpose: the policy engine (Stage 9)
 * replaces it.
 */
export interface PolicyDecision {
  effect: 'ALLOW' | 'DENY';
  reason?: string;
}

export interface ReadInput {
  runtime: SankhyaRuntime;
  catalog: Catalog;
  sql: string;
  /** Rows returned at most; one more is fetched to know whether the result was cut. */
  maxRows: number;
  signal: AbortSignal;
  decide: (analysis: ReadAnalysis) => PolicyDecision;
}

export interface ReadOutput {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  /**
   * Why the result was cut: more than maxRows rows came back (`maxRows`), or the gateway stopped
   * at its own cap before reaching maxRows (`gateway`). Null when the result is complete.
   */
  truncatedBy: 'maxRows' | 'gateway' | null;
  durationMs: number;
}

/**
 * Runs one read against a Sankhya connection. Order: token gate, AST allowlist (in the
 * connection's dialect), every table resolved against the catalog, policy decision, row-cap
 * wrapper, then the gateway. Anything that cannot be parsed or recognised is refused.
 */
export async function executeRead(input: ReadInput): Promise<ReadOutput> {
  const { runtime, catalog, sql, maxRows, signal, decide } = input;
  const started = performance.now();
  if (!Number.isSafeInteger(maxRows) || maxRows < 1)
    throw new AppError('INTERNAL_ERROR', 'maxRows must be a positive integer');
  throwIfAborted(signal);

  const gate = tokenGate(sql);
  if (!gate.ok) throw new AppError('SQL_FORBIDDEN', `Statement refused: ${gate.reason}`);

  const analysis = analyzeRead(sql, { dialect: runtime.dialect });
  assertTablesKnown(analysis, catalog);

  const decision = decide(analysis);
  if (decision.effect !== 'ALLOW')
    throw new AppError('FORBIDDEN', decision.reason ?? 'The read was denied by policy');

  const wrapped = rowCapWrapper(stripTrailingSemicolon(sql), runtime.dialect, maxRows, analysis);
  // The wrapper only adds fixed text and a number, but what reaches the gateway is gated again.
  if (!tokenGate(wrapped).ok)
    throw new AppError('INTERNAL_ERROR', 'The capped statement did not pass the token gate');
  throwIfAborted(signal);
  let result;
  try {
    result = await runtime.client.executeQuery(wrapped, signal);
  } catch (err) {
    if (signal.aborted) throw cancelled(signal);
    throw err;
  }
  const over = result.rows.length > maxRows;
  const truncatedBy = over ? 'maxRows' : result.truncated ? 'gateway' : null;
  return {
    columns: result.columns,
    rows: over ? result.rows.slice(0, maxRows) : result.rows,
    truncated: truncatedBy !== null,
    truncatedBy,
    durationMs: Math.round(performance.now() - started),
  };
}

function assertTablesKnown(analysis: ReadAnalysis, catalog: Catalog): void {
  const known = new Set(catalog.tables.map((t) => t.name.toUpperCase()));
  const missing = analysis.tables.find((t) => !known.has(t.name.toUpperCase()));
  if (!missing) return;
  // A degraded table list may simply not have seen the table yet; still fail closed.
  const incomplete = (catalog.degraded ?? []).some((d) => d.split(':')[0] === 'TDDTAB');
  throw new AppError(
    'RESOURCE_NOT_FOUND',
    incomplete
      ? `Table ${missing.name} is not in the catalog of this connection; the catalog is incomplete, refresh it and try again`
      : `Table ${missing.name} is not in the catalog of this connection`,
    { table: missing.name },
  );
}

/**
 * Caps the rows the gateway returns at maxRows + 1, so a cut result can be told from a full one.
 * The read is sent as it is, and capped on our side, when wrapping would change or break it:
 * a select list that `SELECT * FROM (…)` cannot reproduce (unaliased expressions, qualified or
 * multi-source stars, duplicate output names; see ReadAnalysis.rowCapSafe), and on T-SQL an
 * outer ORDER BY or a WITH, which a derived table without TOP does not accept.
 *
 * The limit is inlined rather than bound: it is a validated safe integer and the gateway's
 * executeQuery takes no bind parameters.
 */
function rowCapWrapper(
  sql: string,
  dialect: SankhyaRuntime['dialect'],
  maxRows: number,
  analysis: ReadAnalysis,
): string {
  const limit = maxRows + 1;
  if (!analysis.rowCapSafe) return sql;
  if (dialect === 'oracle') return `SELECT * FROM (${sql}) WHERE ROWNUM <= ${limit}`;
  if (analysis.orderBy || analysis.ctes.length > 0) return sql;
  return `SELECT TOP (${limit}) * FROM (${sql}) AS dbx_q`;
}

/**
 * Removes the one trailing `;` the gate accepts. After the gate passed, a final `;` can only be
 * that statement terminator (comments and unterminated literals were refused).
 */
function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/, '').trim();
}

function cancelled(signal: AbortSignal): AppError {
  const reason: unknown = signal.reason;
  if (isAppError(reason)) return reason;
  return new AppError('QUERY_CANCELLED', 'The query was cancelled');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal);
}
