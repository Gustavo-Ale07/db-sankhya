/**
 * Structural diff between the current and the desired TableModel, graded
 * SAFE / CAUTION / DESTRUCTIVE:
 * - SAFE: create the table, add a nullable field, relax NOT NULL, change a
 *   default or a description.
 * - CAUTION: add a required field, widen a size, make a field required.
 * - DESTRUCTIVE: drop a field, narrow a size, change a type, rename a field or
 *   the table, change the primary key.
 * A dropped and an added field with identical definitions are reported as one
 * rename when that pairing is unique; otherwise as DROP + ADD. Models are
 * compared as given; validate them first.
 */
import type { FieldModel, TableModel } from './model';

export type DdlSeverity = 'SAFE' | 'CAUTION' | 'DESTRUCTIVE';

export type DdlChangeKind =
  | 'CREATE_TABLE'
  | 'RENAME_TABLE'
  | 'ADD_FIELD'
  | 'DROP_FIELD'
  | 'RENAME_FIELD'
  | 'CHANGE_TYPE'
  | 'WIDEN_SIZE'
  | 'NARROW_SIZE'
  | 'CHANGE_REQUIRED'
  | 'CHANGE_DEFAULT'
  | 'CHANGE_DESCRIPTION'
  | 'CHANGE_PRIMARY_KEY';

export interface DdlChange {
  kind: DdlChangeKind;
  /** The field affected (its new name for RENAME_FIELD). */
  field?: string;
  /** Previous name, for RENAME_FIELD and RENAME_TABLE. */
  from?: string;
  /** The current primary key (field names as in the desired model), for CHANGE_PRIMARY_KEY. */
  previousPrimaryKey?: string[];
  severity: DdlSeverity;
  note: string;
}

export interface DdlDiff {
  changes: DdlChange[];
  severity: DdlSeverity;
}

const RANK: Record<DdlSeverity, number> = { SAFE: 0, CAUTION: 1, DESTRUCTIVE: 2 };

export function worstSeverity(severities: Iterable<DdlSeverity>): DdlSeverity {
  let worst: DdlSeverity = 'SAFE';
  for (const s of severities) if (RANK[s] > RANK[worst]) worst = s;
  return worst;
}

function sameDefinition(a: FieldModel, b: FieldModel): boolean {
  return (
    a.dataType === b.dataType &&
    a.size === b.size &&
    a.scale === b.scale &&
    a.required === b.required &&
    a.default === b.default
  );
}

function describeType(f: FieldModel): string {
  if (f.size === undefined) return f.dataType;
  return f.scale === undefined ? `${f.dataType}(${f.size})` : `${f.dataType}(${f.size},${f.scale})`;
}

/** Digits an unsized INTEIRO holds (Oracle NUMBER(10); MSSQL INT holds fewer). */
const UNSIZED_INTEGER_DIGITS = 10;

/**
 * Compares the sizes of two fields of the same type: -1 when anything narrows,
 * 1 when something widens and nothing narrows, 0 when equal. Numeric types
 * compare integer digits (`size - scale`) and scale separately, so trading
 * integer digits for decimals is a narrowing. A sized number becoming unsized
 * is a narrowing (MSSQL INT / FLOAT are not wider than NUMERIC(p,s)).
 */
function compareSize(from: FieldModel, to: FieldModel): number {
  if (from.dataType !== 'INTEIRO' && from.dataType !== 'DECIMAL') {
    if (from.size === to.size) return 0;
    if (from.size === undefined) return -1;
    if (to.size === undefined) return 1;
    return Math.sign(to.size - from.size);
  }
  if (from.size === undefined && to.size === undefined) return 0;
  if (to.size === undefined) return -1;
  if (from.size === undefined) {
    if (from.dataType === 'DECIMAL') return -1;
    return to.size >= UNSIZED_INTEGER_DIGITS ? 1 : -1;
  }
  const fromScale = from.scale ?? 0;
  const toScale = to.scale ?? 0;
  const intDelta = to.size - toScale - (from.size - fromScale);
  const scaleDelta = toScale - fromScale;
  if (intDelta < 0 || scaleDelta < 0) return -1;
  return intDelta > 0 || scaleDelta > 0 ? 1 : 0;
}

function fieldChanges(from: FieldModel, to: FieldModel): DdlChange[] {
  const field = to.name;
  const out: DdlChange[] = [];
  if (from.dataType !== to.dataType) {
    out.push({
      kind: 'CHANGE_TYPE',
      field,
      severity: 'DESTRUCTIVE',
      note:
        `Type changes from ${describeType(from)} to ${describeType(to)}; existing data may not ` +
        'convert, and Oracle only changes the type of an empty column.',
    });
  } else {
    const cmp = compareSize(from, to);
    if (cmp < 0) {
      out.push({
        kind: 'NARROW_SIZE',
        field,
        severity: 'DESTRUCTIVE',
        note: `Size narrows from ${describeType(from)} to ${describeType(to)}; values may be truncated or rejected.`,
      });
    } else if (cmp > 0) {
      out.push({
        kind: 'WIDEN_SIZE',
        field,
        severity: 'CAUTION',
        note: `Size widens from ${describeType(from)} to ${describeType(to)}.`,
      });
    }
  }
  if (from.required !== to.required) {
    out.push(
      to.required
        ? {
            kind: 'CHANGE_REQUIRED',
            field,
            severity: 'CAUTION',
            note: `${field} becomes required; existing NULL values will block the change.`,
          }
        : { kind: 'CHANGE_REQUIRED', field, severity: 'SAFE', note: `${field} becomes optional.` },
    );
  }
  if (from.default !== to.default) {
    out.push({
      kind: 'CHANGE_DEFAULT',
      field,
      severity: 'SAFE',
      note: `Default changes from ${from.default ?? 'none'} to ${to.default ?? 'none'}.`,
    });
  }
  if (from.description !== to.description) {
    out.push({
      kind: 'CHANGE_DESCRIPTION',
      field,
      severity: 'SAFE',
      note: `Description of ${field} changes (dictionary only).`,
    });
  }
  return out;
}

export function diffTable(current: TableModel | null, desired: TableModel): DdlDiff {
  if (current === null) {
    return {
      changes: [
        {
          kind: 'CREATE_TABLE',
          severity: 'SAFE',
          note: `Creates ${desired.name} with ${desired.fields.length} field(s).`,
        },
      ],
      severity: 'SAFE',
    };
  }

  const changes: DdlChange[] = [];
  if (current.name !== desired.name) {
    changes.push({
      kind: 'RENAME_TABLE',
      from: current.name,
      severity: 'DESTRUCTIVE',
      note: `Renames table ${current.name} to ${desired.name}; anything referring to the old name breaks.`,
    });
  }

  const currentByName = new Map(current.fields.map((f) => [f.name, f]));
  const desiredNames = new Set(desired.fields.map((f) => f.name));
  const dropped = current.fields.filter((f) => !desiredNames.has(f.name));
  const added = desired.fields.filter((f) => !currentByName.has(f.name));

  // Pair a dropped field with an added one of identical definition (a rename),
  // but only when the pairing is unambiguous in both directions. Otherwise the
  // change is a DROP + ADD, which is still DESTRUCTIVE.
  const renamedFrom = new Map<string, string>();
  const consumed = new Set<string>();
  for (const a of added) {
    const matches = dropped.filter((d) => sameDefinition(d, a));
    if (matches.length !== 1) continue;
    const match = matches[0]!;
    if (added.filter((other) => sameDefinition(match, other)).length !== 1) continue;
    consumed.add(match.name);
    renamedFrom.set(a.name, match.name);
  }

  for (const f of desired.fields) {
    const before = currentByName.get(f.name);
    const oldName = renamedFrom.get(f.name);
    if (oldName !== undefined) {
      changes.push({
        kind: 'RENAME_FIELD',
        field: f.name,
        from: oldName,
        severity: 'DESTRUCTIVE',
        note: `Renames ${oldName} to ${f.name}; anything referring to the old name breaks.`,
      });
      const old = current.fields.find((c) => c.name === oldName);
      if (old && old.description !== f.description) {
        changes.push(...fieldChanges({ ...old, name: f.name }, f));
      }
    } else if (before) {
      changes.push(...fieldChanges(before, f));
    } else {
      changes.push(
        f.required
          ? {
              kind: 'ADD_FIELD',
              field: f.name,
              severity: 'CAUTION',
              note: `Adds required field ${f.name}; existing rows need a value${f.default === undefined ? ' and no default is set' : ''}.`,
            }
          : {
              kind: 'ADD_FIELD',
              field: f.name,
              severity: 'SAFE',
              note: `Adds optional field ${f.name}.`,
            },
      );
    }
  }

  for (const d of dropped) {
    if (consumed.has(d.name)) continue;
    changes.push({
      kind: 'DROP_FIELD',
      field: d.name,
      severity: 'DESTRUCTIVE',
      note: `Drops ${d.name} and all of its data. AutoDDL never drops fields; use a dbscript.`,
    });
  }

  const pkBefore = current.primaryKey.map((k) => renamedFromInverse(renamedFrom, k));
  if (pkBefore.join(',') !== desired.primaryKey.join(',')) {
    changes.push({
      kind: 'CHANGE_PRIMARY_KEY',
      previousPrimaryKey: pkBefore,
      severity: 'DESTRUCTIVE',
      note: `Primary key changes from (${current.primaryKey.join(', ')}) to (${desired.primaryKey.join(', ')}).`,
    });
  }

  return { changes, severity: worstSeverity(changes.map((c) => c.severity)) };
}

/** Maps an old field name to its new name when it was renamed. */
function renamedFromInverse(renamedFrom: Map<string, string>, oldName: string): string {
  for (const [to, from] of renamedFrom) if (from === oldName) return to;
  return oldName;
}
