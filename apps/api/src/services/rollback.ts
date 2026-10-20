/**
 * Assisted rollback (Task 13.2). From the audit record of a VERIFIED UPDATE, builds the UPDATE
 * statements that would put the before values back, one per target, keyed by primary key.
 *
 * It never writes: the route hands the first statement to `MutationService.prepare`, so a
 * rollback follows the whole lifecycle (policy, preview, confirmation, re-authorization) like any
 * other write. The SQL is rendered from engine AST nodes through `renderExpr`, the same renderer
 * (and literal escaping) the mutation preview uses; identifiers must be plain names.
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
import { renderExpr } from './mutations';
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
    if (v.length > SNAPSHOT_MAX_STRING_CHARS) return 'a value was clipped in the audit';
    return null;
  }
  if (typeof v === 'number') {
    return Number.isFinite(v) && PLAIN_NUMBER.test(String(v))
      ? null
      : 'a numeric value cannot be written back exactly';
  }
  if (typeof v === 'boolean') return null;
  return 'a value is not a plain scalar';
}

/** Gateway booleans are S/N flags; everything else is written as stored. */
const literal = (v: Value): Expr => ({
  kind: 'literal',
  value: typeof v === 'boolean' ? (v ? 'S' : 'N') : v,
});

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
    targets.push({ key, restore, expectedCurrent, sql });
  }
  return { ok: true, entity, connectionId: event.connectionId, targets };
}

/** `UPDATE <entity> SET <col> = <before> … WHERE <pk> = …` through the preview's renderer. */
function render(
  entity: string,
  restore: Record<string, Value>,
  key: Record<string, Value>,
): string {
  const columns = [...Object.keys(restore), ...Object.keys(key)];
  const known = new Set(columns);
  const qualifiers = new Set([entity]);
  const r = (e: Expr) => renderExpr(e, qualifiers, known);
  const set = Object.entries(restore)
    .map(([col, v]) => `${r({ kind: 'column', name: col })} = ${r(literal(v))}`)
    .join(', ');
  const where = Object.entries(key)
    .map(([k, v]): Expr => ({
      kind: 'compare',
      op: '=',
      left: { kind: 'column', name: k },
      right: literal(v),
    }))
    .reduce((left, right): Expr => ({ kind: 'and', left, right }));
  return `UPDATE ${entity} SET ${set} WHERE ${r(where)}`;
}

/**
 * The rollback of a verified UPDATE: one statement per target, joined for display. null when the
 * event cannot be rolled back (see {@link analyzeRollback} for the reason).
 */
export function buildRollbackSql(event: AuditEventRow): string | null {
  const a = analyzeRollback(event);
  return a.ok ? a.targets.map((t) => t.sql).join(';\n') : null;
}
