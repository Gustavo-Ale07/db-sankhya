/**
 * Assisted rollback (Task 13.2). From the audit record of a VERIFIED UPDATE, builds the UPDATE
 * statements that would put the before values back, one per target, keyed by primary key.
 *
 * It never writes: the route hands the first statement to `MutationService.prepare`, so a
 * rollback follows the whole lifecycle (policy, preview, confirmation, re-authorization) like any
 * other write. Identifiers must be plain names, numbers plain notation, and string literals are
 * escaped for the engine parser (which reads backslash escapes, so backslashes are doubled as well
 * as quotes). Every generated statement is then parsed back and must yield exactly the intended
 * table, SET values and key (same type, same value): anything else refuses the rollback.
 *
 * Fails closed (no plan) whenever the audit cannot restore the row faithfully: no snapshot
 * (auditSnapshots=false), an incomplete snapshot, a redacted or clipped value, a key that does
 * not match its row, a value the parser could not read back, or anything but a successful,
 * VERIFIED UPDATE of a Sankhya table.
 */
import type { AuditEventRow } from '@dbx/database';
import { REDACTED, SNAPSHOT_MAX_STRING_CHARS } from '@dbx/shared';
import { classifyStatement } from '@dbx/sql-engine';
import type { Expr, Value } from '@dbx/sql-engine';
import { SCRATCH_CONNECTION_ID } from './read-policy';

/** The label every rollback plan carries. */
export const ROLLBACK_LABEL = 'assisted rollback — requires new preview and confirmation';

export interface RollbackTarget {
  key: Record<string, Value>;
  /** The values the rollback writes (the snapshot's before). */
  restore: Record<string, Value>;
  /** The values the row should hold now (the snapshot's after); anything else is a conflict. */
  expectedCurrent: Record<string, Value>;
  sql: string;
}

export type RollbackAnalysis =
  | { ok: true; entity: string; connectionId: string; targets: RollbackTarget[] }
  | { ok: false; reason: string };

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Numbers in the plain notation the SQL parser reads back exactly. */
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

const no = (reason: string): RollbackAnalysis => ({ ok: false, reason });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface SnapshotSide {
  rows: unknown[];
  truncated: boolean;
  totalRows: number;
}

function side(v: unknown): SnapshotSide | null {
  if (!isRecord(v) || !Array.isArray(v.rows)) return null;
  return {
    rows: v.rows,
    truncated: v.truncated === true,
    totalRows: typeof v.totalRows === 'number' ? v.totalRows : -1,
  };
}

/** Why a stored value cannot be written back as is, or null when it can. */
function unrestorable(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v === 'string') {
    if (v.includes(REDACTED)) return 'a value was redacted in the audit';
    // The snapshot clips at SNAPSHOT_MAX_STRING_CHARS plus an ellipsis; a cut that split a
    // surrogate pair drops the orphan, so a clipped value can be exactly the limit long.
    if (
      v.length > SNAPSHOT_MAX_STRING_CHARS ||
      (v.length === SNAPSHOT_MAX_STRING_CHARS && v.endsWith(ELLIPSIS))
    ) {
      return 'a value was clipped in the audit';
    }
    return null;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) && PLAIN_NUMBER.test(String(v))
      ? null
      : 'a numeric value cannot be written back exactly';
  }
  if (typeof v === 'boolean') return 'a boolean value has no literal in the gateway dialects';
  return 'a value is not a plain scalar';
}

const ELLIPSIS = '…';
const BACKSLASH = String.fromCharCode(92);

/**
 * A SQL literal the engine parser reads back as `v`: quotes doubled and, because the parser
 * honours backslash escapes, backslashes doubled too. Numbers are already plain notation.
 */
function literalSql(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    return `'${v
      .split(BACKSLASH)
      .join(BACKSLASH + BACKSLASH)
      .split("'")
      .join("''")}'`;
  }
  throw new Error('unsupported literal');
}

const sameScalar = (a: unknown, b: unknown) =>
  a === b || (a !== null && b !== null && a !== undefined && String(a) === String(b));

/** The rollback statements of a PLAN_EXECUTED event, or why there are none. */
export function analyzeRollback(event: AuditEventRow): RollbackAnalysis {
  if (event.action !== 'PLAN_EXECUTED') return no('Only an executed plan can be rolled back.');
  const details = isRecord(event.details) ? event.details : {};
  if (details.operation !== 'UPDATE') return no('Only an UPDATE can be rolled back.');
  if (event.connectionId === SCRATCH_CONNECTION_ID || !event.connectionId) {
    return no('A scratch write has no keyed rows to restore.');
  }
  const report = isRecord(details.report) ? details.report : null;
  if (event.status !== 'success' || report?.status !== 'success') {
    return no('Only a fully successful execution can be rolled back.');
  }
  if (report.verification !== 'VERIFIED') {
    return no('Only a VERIFIED execution can be rolled back: its result was not confirmed.');
  }
  const steps = Array.isArray(report.steps) ? report.steps : [];

  const snapshot = isRecord(event.snapshot) ? event.snapshot : null;
  const before = side(snapshot?.before);
  const after = side(snapshot?.after);
  if (!snapshot || !before || !after) {
    return no(
      'The audit holds no snapshot of the rows (snapshots are disabled by policy, ' +
        'auditSnapshots=false), so the previous values are unknown.',
    );
  }
  if (
    before.truncated ||
    after.truncated ||
    before.rows.length !== before.totalRows ||
    after.rows.length !== before.rows.length ||
    before.rows.length !== steps.length ||
    steps.length === 0
  ) {
    return no('The snapshot is incomplete: not every changed row was recorded.');
  }

  // The SET columns come from the executed statement itself.
  let setColumns: string[];
  let entity: string;
  try {
    const c = event.statement ? classifyStatement(event.statement) : null;
    if (!c || c.kind !== 'UPDATE' || c.stmt?.type !== 'update') {
      return no('The executed statement cannot be read back.');
    }
    entity = c.table.toUpperCase();
    setColumns = c.stmt.set.map((s) => s.column.toUpperCase());
  } catch {
    return no('The executed statement cannot be read back.');
  }
  if (!IDENT.test(entity) || setColumns.some((c) => !IDENT.test(c))) {
    return no('A table or column name is not a plain identifier.');
  }

  const targets: RollbackTarget[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const b = before.rows[i];
    const a = after.rows[i];
    if (!isRecord(step) || !isRecord(step.key) || !isRecord(b) || !isRecord(a)) {
      return no('The snapshot is incomplete: not every changed row was recorded.');
    }
    const stepKey = step.key;
    const pk = Object.keys(stepKey);
    if (pk.length === 0 || pk.some((k) => !IDENT.test(k))) {
      return no('A changed row has no usable primary key.');
    }
    for (const k of pk) {
      const why = unrestorable(step.key[k]);
      if (why) return no(`The key cannot be used: ${why}.`);
      if (step.key[k] === null || !sameScalar(step.key[k], b[k]) || !sameScalar(b[k], a[k])) {
        return no('A recorded key does not match its snapshot row.');
      }
    }
    const restore: Record<string, Value> = {};
    const expectedCurrent: Record<string, Value> = {};
    for (const col of setColumns) {
      if (!(col in b) || !(col in a)) {
        return no(`The snapshot does not hold the previous value of ${col}.`);
      }
      const why = unrestorable(b[col]) ?? unrestorable(a[col]);
      if (why) return no(`The previous value of ${col} cannot be restored: ${why}.`);
      restore[col] = b[col] as Value;
      expectedCurrent[col] = a[col] as Value;
    }
    const key = Object.fromEntries(pk.map((k) => [k, stepKey[k] as Value]));
    let sql: string;
    try {
      sql = render(entity, restore, key);
    } catch {
      return no('The rollback statement could not be built from the stored values.');
    }
    const mismatch = checkRoundTrip(sql, entity, restore, key);
    if (mismatch) return no(mismatch);
    targets.push({ key, restore, expectedCurrent, sql });
  }
  return { ok: true, entity, connectionId: event.connectionId, targets };
}

/** `UPDATE <entity> SET <col> = <before> … WHERE (<pk> = …)`, the key AND-chained. */
function render(
  entity: string,
  restore: Record<string, Value>,
  key: Record<string, Value>,
): string {
  const set = Object.entries(restore)
    .map(([col, v]) => `${col} = ${literalSql(v)}`)
    .join(', ');
  const where = Object.entries(key)
    .map(([k, v]) => `(${k} = ${literalSql(v)})`)
    .reduce((left, right) => `(${left} AND ${right})`);
  return `UPDATE ${entity} SET ${set} WHERE ${where}`;
}

/** The key as the parser should read it: `k1 = v1 AND k2 = v2 …`, left-associated. */
function keyExpr(key: Record<string, Value>): Expr {
  return Object.entries(key)
    .map(([k, v]): Expr => ({
      kind: 'compare',
      op: '=',
      left: { kind: 'column', name: k },
      right: { kind: 'literal', value: v },
    }))
    .reduce((left, right): Expr => ({ kind: 'and', left, right }));
}

const isLiteral = (e: unknown, value: Value): boolean =>
  isRecord(e) && e.kind === 'literal' && e.value === value;

/** Whether the parsed WHERE is exactly the expected key chain (same columns, types and values). */
function sameKey(actual: unknown, expected: Expr): boolean {
  if (!isRecord(actual) || actual.kind !== expected.kind) return false;
  if (expected.kind === 'and')
    return sameKey(actual.left, expected.left) && sameKey(actual.right, expected.right);
  if (expected.kind !== 'compare' || actual.op !== '=' || expected.right.kind !== 'literal')
    return false;
  const left = actual.left;
  return (
    isRecord(left) &&
    left.kind === 'column' &&
    left.table === undefined &&
    typeof left.name === 'string' &&
    expected.left.kind === 'column' &&
    left.name.toUpperCase() === expected.left.name.toUpperCase() &&
    isLiteral(actual.right, expected.right.value)
  );
}

/**
 * Parses a generated rollback statement back and checks the engine reads exactly what was meant:
 * an UPDATE of `entity`, the SET columns in order with literals strictly equal to `restore`, and
 * a WHERE that is exactly the key chain. Returns why not, or null when it round-trips.
 */
export function checkRoundTrip(
  sql: string,
  entity: string,
  restore: Record<string, Value>,
  key: Record<string, Value>,
): string | null {
  const why = 'The rollback statement would not be read back as the stored values.';
  let c: ReturnType<typeof classifyStatement>;
  try {
    c = classifyStatement(sql);
  } catch {
    return why;
  }
  if (c.kind !== 'UPDATE' || c.stmt?.type !== 'update') return why;
  const stmt = c.stmt;
  if (c.table.toUpperCase() !== entity.toUpperCase()) return why;
  if (isRecord(stmt.table) && stmt.table.schema !== undefined) return why;
  const wanted = Object.entries(restore);
  if (stmt.set.length !== wanted.length) return why;
  for (let i = 0; i < wanted.length; i++) {
    const [col, value] = wanted[i]!;
    const got = stmt.set[i]!;
    if (got.column.toUpperCase() !== col.toUpperCase() || !isLiteral(got.value, value)) return why;
  }
  return sameKey(stmt.where, keyExpr(key)) ? null : why;
}

/**
 * The rollback of a verified UPDATE: one statement per target, joined for display. null when the
 * event cannot be rolled back (see {@link analyzeRollback} for the reason).
 */
export function buildRollbackSql(event: AuditEventRow): string | null {
  const a = analyzeRollback(event);
  return a.ok ? a.targets.map((t) => t.sql).join(';\n') : null;
}
