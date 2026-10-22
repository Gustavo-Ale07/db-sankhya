/**
 * Capability resolution (audit §6): maps a classified statement to what the
 * platform can actually do with it. It never invents Sankhya support: generic
 * DELETE and native DDL are UNSUPPORTED for every role, custom (AD_*) DDL only
 * becomes a generated Add-on Studio artifact, and scratch tables stay local.
 */
import type { Classified } from './classify';

export const CAPABILITY_CLASSES = [
  'SUPPORTED',
  'SUPPORTED_VIA_GENERATED_ARTIFACT',
  'SCRATCH_ONLY',
  'UNSUPPORTED',
] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/**
 * `SANKHYA_ACTION` is never produced by `resolveCapability`: it marks a plan for a typed business
 * action of the API registry (a gateway service call, not a SQL statement).
 */
export type CapabilityRoute =
  | 'SANKHYA_READ'
  | 'SANKHYA_SAVE'
  | 'SANKHYA_ACTION'
  | 'SCRATCH'
  | 'HYBRID'
  | 'DDL_ARTIFACT'
  | 'NONE';

/** Subset of the RBAC permission strings (Stage 8) a capability can require. */
export type CapabilityAction =
  | 'QUERY.SELECT'
  | 'TEMP.CREATE'
  | 'TEMP.WRITE'
  | 'TEMP.DROP'
  | 'TEMP.MATERIALIZE'
  | 'DATA.INSERT'
  | 'DATA.UPDATE'
  | 'DATA.DELETE'
  | 'SANKHYA.BUSINESS_ACTION.EXECUTE'
  | 'SANKHYA.ACTION.CANCELAR_NOTA'
  | 'SANKHYA.ACTION.INCLUIR_NOTA'
  | 'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA'
  | 'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA'
  | 'DDL.CUSTOM.GENERATE';

export interface Capability {
  class: CapabilityClass;
  route: CapabilityRoute;
  reason: string;
  /** Primary permission to check; null when nothing can run. */
  action: CapabilityAction | null;
  /** Every permission the route needs (includes `action`). */
  actions: CapabilityAction[];
  /** Set for UPDATE / DELETE without WHERE: the policy engine must block it. */
  blocked?: { code: 'MISSING_WHERE'; reason: string };
}

export interface CapabilityContext {
  catalog: { tables: { name: string }[] };
  /** Custom-table prefixes, default `['AD_']`. Matched case-insensitively. */
  customPrefixes?: readonly string[];
  /**
   * Names of the caller's scratch tables. Matched case-insensitively. A name
   * only counts as scratch when it also starts with `tmp_` and is neither in
   * the catalog nor custom, so a stray native name here is never trusted.
   */
  scratchTables: Iterable<string>;
}

export const DEFAULT_CUSTOM_PREFIXES: readonly string[] = ['AD_'];

/** Every scratch table name starts with this prefix (case-insensitive). */
const SCRATCH_PREFIX = /^tmp_/i;

function cap(
  klass: CapabilityClass,
  route: CapabilityRoute,
  reason: string,
  actions: CapabilityAction[] = [],
): Capability {
  return { class: klass, route, reason, action: actions[0] ?? null, actions };
}

const unsupported = (reason: string): Capability => cap('UNSUPPORTED', 'NONE', reason);

export function resolveCapability(c: Classified, ctx: CapabilityContext): Capability {
  const scratch = new Set([...ctx.scratchTables].map((t) => t.toUpperCase()));
  const catalog = new Set(ctx.catalog.tables.map((t) => t.name.toUpperCase()));
  const prefixes = (ctx.customPrefixes ?? DEFAULT_CUSTOM_PREFIXES).map((p) => p.toUpperCase());
  const isCustom = (t: string) => prefixes.some((p) => t.toUpperCase().startsWith(p));
  /** A name a scratch table may carry: `tmp_…`, not a catalog table, not custom. */
  const isScratchName = (t: string) =>
    SCRATCH_PREFIX.test(t) && !catalog.has(t.toUpperCase()) && !isCustom(t);
  const isScratch = (t: string) => isScratchName(t) && scratch.has(t.toUpperCase());
  const readsSankhya = (tables: string[]) => tables.some((t) => !isScratch(t));

  switch (c.kind) {
    case 'UNKNOWN':
      return unsupported(`Unrecognised statement: ${c.reason}`);

    case 'SELECT': {
      const local = c.tables.filter(isScratch);
      if (c.tables.length > 0 && local.length === c.tables.length) {
        return cap('SCRATCH_ONLY', 'SCRATCH', 'Reads only scratch tables.', ['QUERY.SELECT']);
      }
      if (local.length > 0) {
        return cap(
          'SUPPORTED',
          'HYBRID',
          'Joins Sankhya tables with scratch tables: Sankhya rows are materialised locally first.',
          ['QUERY.SELECT', 'TEMP.MATERIALIZE'],
        );
      }
      return cap('SUPPORTED', 'SANKHYA_READ', 'Read through the Sankhya query service.', [
        'QUERY.SELECT',
      ]);
    }

    case 'INSERT':
    case 'UPDATE':
    case 'DELETE': {
      const result = writeCapability(c, isScratch, readsSankhya, catalog);
      if (c.kind !== 'INSERT' && !c.hasWhere && result.class !== 'UNSUPPORTED') {
        result.blocked = {
          code: 'MISSING_WHERE',
          reason: `${c.kind} without WHERE affects every row and is blocked.`,
        };
      }
      return result;
    }

    case 'CREATE_TABLE': {
      const touched = ddlTables(c.ast, c.table);
      // A tmp_ table lives in the caller's scratch, TEMPORARY or not; it is never an artifact.
      if (isScratchName(c.table)) {
        const foreign = touched.find((t) => !isScratchName(t));
        if (foreign !== undefined) {
          return unsupported(`${c.table}: a scratch table may not reference ${foreign}.`);
        }
        return readsSankhya(c.sourceTables)
          ? cap(
              'SCRATCH_ONLY',
              'HYBRID',
              'Temporary table filled from Sankhya rows materialised locally.',
              ['TEMP.CREATE', 'TEMP.MATERIALIZE', 'QUERY.SELECT'],
            )
          : cap('SCRATCH_ONLY', 'SCRATCH', 'Temporary table in the local scratch area.', [
              'TEMP.CREATE',
            ]);
      }
      // A temporary request must never become a permanent Add-on artifact.
      if (c.temporary) {
        return unsupported(
          `${c.table}: temporary tables must use the tmp_ prefix${isCustom(c.table) ? '.' : '; native DDL forbidden.'}`,
        );
      }
      if (isCustom(c.table)) {
        if (isNode(c.ast) && !isNil(c.ast.query_expr)) {
          return unsupported(
            'CREATE TABLE … AS SELECT cannot be expressed as an Add-on Studio artifact.',
          );
        }
        const foreign = touched.find((t) => !isCustom(t));
        if (foreign !== undefined) {
          return unsupported(`${c.table}: custom DDL may not reference ${foreign}.`);
        }
        return customDdl(c.table);
      }
      return unsupported(
        `${c.table}: native DDL forbidden. Only custom tables (${prefixes.join(', ')}) can be created, as generated artifacts.`,
      );
    }

    case 'ALTER_TABLE':
    case 'DROP_TABLE': {
      const touched = ddlTables(c.ast, c.table);
      if (isScratch(c.table)) {
        const foreign = touched.find((t) => !isScratchName(t));
        if (foreign !== undefined) {
          return unsupported(`${c.table}: a scratch table may not reference ${foreign}.`);
        }
        return cap('SCRATCH_ONLY', 'SCRATCH', 'Changes a local scratch table.', [
          c.kind === 'DROP_TABLE' ? 'TEMP.DROP' : 'TEMP.CREATE',
        ]);
      }
      if (isCustom(c.table)) {
        if (hasRename(c.ast)) {
          return unsupported(`${c.table}: renaming tables is not supported (audit §3.3).`);
        }
        const foreign = touched.find((t) => !isCustom(t));
        if (foreign !== undefined) {
          return unsupported(`${c.table}: custom DDL may not reference ${foreign}.`);
        }
        return customDdl(c.table);
      }
      return unsupported(`${c.table}: native DDL forbidden, for every role.`);
    }
  }
}

/** Nullish check (the AST uses both null and undefined for absent parts). */
function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

function isNode(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every table name a DDL statement touches: the target plus any table-shaped
 * node in its AST (RENAME TO target, REFERENCES …). The CREATE … AS SELECT
 * source query is skipped; its tables are the statement's source tables.
 */
function ddlTables(ast: unknown, target: string): string[] {
  const names = [target];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isNode(v)) return;
    if (typeof v.table === 'string' && v.type !== 'column_ref' && !('column' in v)) {
      names.push(v.table);
    }
    for (const [k, x] of Object.entries(v)) if (k !== 'query_expr') walk(x);
  };
  walk(ast);
  return names;
}

/** True when the DDL AST contains a RENAME action anywhere. */
function hasRename(ast: unknown): boolean {
  if (Array.isArray(ast)) return ast.some(hasRename);
  if (!isNode(ast)) return false;
  if (ast.action === 'rename') return true;
  return Object.values(ast).some(hasRename);
}

function customDdl(table: string): Capability {
  return cap(
    'SUPPORTED_VIA_GENERATED_ARTIFACT',
    'DDL_ARTIFACT',
    `${table} is a custom table: the change is generated as an Add-on Studio artifact, never executed.`,
    ['DDL.CUSTOM.GENERATE'],
  );
}

function writeCapability(
  c: Extract<Classified, { kind: 'INSERT' | 'UPDATE' | 'DELETE' }>,
  isScratch: (t: string) => boolean,
  readsSankhya: (tables: string[]) => boolean,
  catalog: Set<string>,
): Capability {
  if (isScratch(c.table)) {
    return readsSankhya(c.sourceTables)
      ? cap(
          'SCRATCH_ONLY',
          'HYBRID',
          'Writes a scratch table from Sankhya rows materialised locally.',
          ['TEMP.WRITE', 'TEMP.MATERIALIZE', 'QUERY.SELECT'],
        )
      : cap('SCRATCH_ONLY', 'SCRATCH', 'Writes a local scratch table.', ['TEMP.WRITE']);
  }
  if (c.kind === 'DELETE') {
    return unsupported(
      `DELETE on ${c.table}: there is no documented generic delete service in the Sankhya API.`,
    );
  }
  if (!catalog.has(c.table.toUpperCase())) {
    return unsupported(`${c.table} is neither a known Sankhya table nor a scratch table.`);
  }
  if (!c.stmt) {
    return unsupported(
      `This ${c.kind} shape cannot be sent to the Sankhya save service${c.stmtError ? `: ${c.stmtError}` : '.'}`,
    );
  }
  return c.kind === 'INSERT'
    ? cap('SUPPORTED', 'SANKHYA_SAVE', 'Single record saved through the Sankhya save service.', [
        'DATA.INSERT',
      ])
    : cap('SUPPORTED', 'SANKHYA_SAVE', 'Records updated through the Sankhya save service.', [
        'DATA.UPDATE',
      ]);
}
