/**
 * Structural diff between the current and the desired TableModel, graded
 * SAFE / CAUTION / DESTRUCTIVE:
 * - SAFE: create the table, add a nullable field, relax NOT NULL, change a
 *   default or a description.
 * - CAUTION: add a required field, widen a size, make a field required.
 * - DESTRUCTIVE: drop a field, narrow a size, change a type, rename a field or
 *   the table, change the primary key.
 * A dropped and an added field with identical definitions are reported as one
 * rename. Models are compared as given; validate them first.
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

/** Compares an optional bound: undefined means unbounded (the widest). */
function compareBound(from: number | undefined, to: number | undefined): number {
  if (from === to) return 0;
  if (from === undefined) return -1;
  if (to === undefined) return 1;
  return Math.sign(to - from);
}

function fieldChanges(from: FieldModel, to: FieldModel): DdlChange[] {
  const field = to.name;
  const out: DdlChange[] = [];
  if (from.dataType !== to.dataType) {
    out.push({
      kind: 'CHANGE_TYPE',
      field,
      severity: 'DESTRUCTIVE',
      note: `Type changes from ${describeType(from)} to ${describeType(to)}; existing data may not convert.`,
    });
  } else {
    const size = compareBound(from.size, to.size);
    const scale = compareBound(from.scale, to.scale);
    if (size < 0 || scale < 0) {
      out.push({
        kind: 'NARROW_SIZE',
        field,
        severity: 'DESTRUCTIVE',
        note: `Size narrows from ${describeType(from)} to ${describeType(to)}; values may be truncated or rejected.`,
      });
    } else if (size > 0 || scale > 0) {
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

  // Pair a dropped field with an added one of identical definition (a rename).
  const renamedFrom = new Map<string, string>();
  const consumed = new Set<string>();
  for (const a of added) {
    const match = dropped.find((d) => !consumed.has(d.name) && sameDefinition(d, a));
    if (match) {
      consumed.add(match.name);
      renamedFrom.set(a.name, match.name);
    }
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
