/**
 * Reads from the main editor that touch the caller's scratch (`tmp_*`) tables. A read of scratch
 * tables only runs in the workspace. A hybrid read (scratch and Sankhya tables) is split with
 * `splitHybrid`: each Sankhya part is materialized once into an ephemeral scratch table (through
 * `materialize`, so the normal Sankhya read path judges it), the statement is rewritten to read
 * those tables and runs in the workspace, and the ephemeral tables are dropped afterwards.
 */
import { randomBytes } from 'node:crypto';
import { AppError, isAppError } from '@dbx/shared';
import { classifyStatement, splitCreateAs, splitHybrid } from '@dbx/sql-engine';
import type { ScratchWorkspace } from './scratch';
import { analyzeScratchSql } from './scratch-guard';
import type { ScratchStatement } from './scratch-guard';

/** `tmp_*` names belong to scratch; they are never looked up in a Sankhya catalog. */
export const isScratchName = (table: string): boolean => /^tmp_/i.test(table);

/** Sankhya parts a hybrid read may have; more is refused before any gateway call. */
export const MAX_HYBRID_PARTS = 4;
/** Subqueries a hybrid read may contain in all (each is parsed to find the parts). */
export const MAX_HYBRID_SUBQUERIES = 32;

const MATERIALIZE_FIRST =
  'Put each Sankhya part in a WITH or a subquery that reads Sankhya tables only, or materialize ' +
  'it into a tmp_ table first (Scratch page).';

export interface HybridPart {
  /** The Sankhya subquery, as written. */
  sql: string;
  /** The Sankhya tables it reads. */
  tables: string[];
  /** The ephemeral scratch table it is copied into. */
  into: string;
}

export interface ScratchRead {
  /** Empty for a read of scratch tables only. */
  parts: HybridPart[];
  /** What the workspace runs (the rewritten statement for a hybrid read). */
  statement: ScratchStatement;
}

/**
 * Plans a read of scratch tables, or a hybrid read. Throws SQL_UNSUPPORTED (before any gateway
 * call) when a hybrid statement cannot be split into Sankhya-only parts and a scratch remainder.
 */
export function planScratchRead(sql: string, hybrid: boolean): ScratchRead {
  if (!hybrid) return { parts: [], statement: selectOnly(analyzeScratchSql(sql)) };
  // Bounded before any parse: each candidate subquery costs one.
  const split = splitHybrid(sql, isScratchName, {
    maxParts: MAX_HYBRID_PARTS,
    maxGroups: MAX_HYBRID_SUBQUERIES,
  });
  if (split.overflow) {
    throw unsupported(
      `more than ${MAX_HYBRID_PARTS} Sankhya parts or ${MAX_HYBRID_SUBQUERIES} subqueries`,
    );
  }
  if (split.parts.length === 0) throw unsupported('no Sankhya part could be separated');
  const run = randomBytes(5).toString('hex');
  const parts = split.parts.map((p, i) => ({
    sql: p.sql,
    tables: p.tables,
    into: `tmp__hyb_${run}_${i + 1}`,
  }));
  let statement: ScratchStatement;
  try {
    statement = analyzeScratchSql(split.rewrite(parts.map((p) => p.into)));
  } catch (err) {
    // A forbidden construct stays forbidden; anything else means the split left Sankhya tables.
    if (isAppError(err) && err.code !== 'SQL_FORBIDDEN') throw unsupported(err.message);
    throw err;
  }
  return { parts, statement: selectOnly(statement) };
}

/**
 * Plans `CREATE [TEMPORARY] TABLE tmp_x AS <query>` whose query reads Sankhya: a query of Sankhya
 * tables only is copied whole into one ephemeral table, a mixed one is split like a hybrid read;
 * the CREATE then reads the ephemeral tables in the workspace. Throws SQL_UNSUPPORTED (before any
 * gateway call) for anything else.
 */
export function planScratchCreateAs(sql: string): ScratchRead {
  const ca = splitCreateAs(sql);
  if (ca === null) {
    throw new AppError(
      'SQL_UNSUPPORTED',
      'Only CREATE TABLE tmp_… AS SELECT … can fill a scratch table from Sankhya.',
    );
  }
  const run = randomBytes(5).toString('hex');
  const query = classifyStatement(ca.query);
  if (query.kind !== 'SELECT') {
    throw new AppError('SQL_UNSUPPORTED', 'The query of a CREATE TABLE … AS must be a SELECT.');
  }
  let parts: HybridPart[];
  let rewritten: string;
  if (!query.tables.some(isScratchName)) {
    parts = [{ sql: ca.query, tables: query.tables, into: `tmp__hyb_${run}_1` }];
    rewritten = `SELECT * FROM ${parts[0]!.into}`;
  } else {
    const split = splitHybrid(ca.query, isScratchName, {
      maxParts: MAX_HYBRID_PARTS,
      maxGroups: MAX_HYBRID_SUBQUERIES,
    });
    if (split.overflow) {
      throw unsupported(
        `more than ${MAX_HYBRID_PARTS} Sankhya parts or ${MAX_HYBRID_SUBQUERIES} subqueries`,
      );
    }
    if (split.parts.length === 0) throw unsupported('no Sankhya part could be separated');
    parts = split.parts.map((p, i) => ({
      sql: p.sql,
      tables: p.tables,
      into: `tmp__hyb_${run}_${i + 1}`,
    }));
    rewritten = split.rewrite(parts.map((p) => p.into));
  }
  let statement: ScratchStatement;
  try {
    statement = analyzeScratchSql(ca.head + rewritten);
  } catch (err) {
    if (isAppError(err) && err.code !== 'SQL_FORBIDDEN') throw unsupported(err.message);
    throw err;
  }
  if (statement.command !== 'CREATE TABLE') {
    throw new AppError('SQL_UNSUPPORTED', 'Only CREATE TABLE … AS is planned here.');
  }
  return { parts, statement };
}

/** Drops the ephemeral tables of a hybrid read; never throws (they expire with the workspace). */
export async function dropEphemeral(
  workspace: ScratchWorkspace,
  parts: readonly HybridPart[],
  onError: (err: unknown) => void,
): Promise<void> {
  for (const part of parts) {
    try {
      // No signal: a cancelled read must still clean up.
      await workspace.exec(`DROP TABLE IF EXISTS ${part.into}`);
    } catch (err) {
      onError(err);
    }
  }
}

function selectOnly(statement: ScratchStatement): ScratchStatement {
  if (statement.command !== 'SELECT') {
    throw new AppError('SQL_UNSUPPORTED', 'Only a SELECT reads tmp_ tables here.');
  }
  return statement;
}

function unsupported(why: string): AppError {
  return new AppError(
    'SQL_UNSUPPORTED',
    `This query mixes Sankhya and tmp_ tables in a way that cannot run in one step (${why}). ${MATERIALIZE_FIRST}`,
  );
}
