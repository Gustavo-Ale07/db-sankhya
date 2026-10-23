/**
 * Permission catalog. Permissions say what a user may attempt; the policy engine, the global
 * write switches and approvals can still refuse it. No permission grants DDL on native ERP
 * tables: that is refused for everyone, administrators included.
 *
 * A business action needs SANKHYA.BUSINESS_ACTION.EXECUTE and its own SANKHYA.ACTION.*
 * permission; the policy is evaluated on the latter.
 *
 * DATA.PREVIEW lets a user plan and see the preview of an INSERT / UPDATE / DELETE without
 * holding its DATA.* permission. It never executes anything: execution still needs the
 * statement's own permission, and the preview still needs a policy ALLOW for that write action.
 */
export const PERMISSIONS = [
  'QUERY.SELECT',
  'TEMP.CREATE',
  'TEMP.WRITE',
  'TEMP.DROP',
  'TEMP.MATERIALIZE',
  'DATA.PREVIEW',
  'DATA.INSERT',
  'DATA.UPDATE',
  'DATA.DELETE',
  'DDL.CUSTOM.GENERATE',
  'SANKHYA.BUSINESS_ACTION.EXECUTE',
  'SANKHYA.ACTION.CANCELAR_NOTA',
  'SANKHYA.ACTION.INCLUIR_NOTA',
  'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA',
  'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA',
  // Server-side ("Executa Banco") execution categories: the statements the gateway cannot run,
  // dispatched through the client's server-side DBScript routine. Each is a write: it needs an
  // explicit policy ALLOW, and it only runs behind the SERVER_SQL_ENABLED master switch and the
  // environment gate (HOMOLOGATION / SANDBOX first). Held by SUPER_ADMIN only, by default.
  'SERVER.DDL',
  'SERVER.DELETE',
  'SERVER.DML_RAW',
  'SERVER.DCL',
  'SERVER.PLSQL',
  'APPROVAL.DECIDE',
  'AUDIT.READ',
  'ADMIN.USERS',
  'ADMIN.GROUPS',
  'ADMIN.ROLES',
  'ADMIN.POLICIES',
  'ADMIN.CONNECTIONS',
  'ADMIN.SECURITY',
  // Lets an account administer access policies despite holding write permissions: the one, explicit
  // relaxation of separation of duties. Not an ADMIN.* (regular ADMIN must not hold it) and not a
  // write (it is never policy-evaluated). Held by SUPER_ADMIN only.
  'SECURITY.SEGREGATION_OVERRIDE',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CATALOG: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return CATALOG.has(value);
}

export const SYSTEM_ROLES = ['VIEWER', 'OPERATOR', 'ADMIN', 'SUPER_ADMIN'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Marks an account exempt from separation of duties (may administer policies while holding writes). */
export const SEGREGATION_OVERRIDE: Permission = 'SECURITY.SEGREGATION_OVERRIDE';

const TEMP: Permission[] = ['TEMP.CREATE', 'TEMP.WRITE', 'TEMP.DROP', 'TEMP.MATERIALIZE'];
const VIEWER: Permission[] = ['QUERY.SELECT', ...TEMP];
const OPERATOR: Permission[] = [...VIEWER, 'DATA.PREVIEW', 'DATA.INSERT', 'DATA.UPDATE'];
/**
 * Administers the tool. Apart from DATA.PREVIEW (see a planned write, never run it) it gets no
 * DATA.*, DDL.* or SANKHYA.* permission by default: an administrator who must also write ERP
 * data needs an additional role.
 */
const ADMIN: Permission[] = [
  'QUERY.SELECT',
  ...TEMP,
  'DATA.PREVIEW',
  'APPROVAL.DECIDE',
  'AUDIT.READ',
  'ADMIN.USERS',
  'ADMIN.GROUPS',
  'ADMIN.ROLES',
  'ADMIN.POLICIES',
  'ADMIN.CONNECTIONS',
  'ADMIN.SECURITY',
];

/**
 * Every command executed through the server-side ("Executa Banco") route. They are writes kept from
 * policy administrators like the DATA.* / SANKHYA.* writes.
 */
const SERVER: Permission[] = [
  'SERVER.DDL',
  'SERVER.DELETE',
  'SERVER.DML_RAW',
  'SERVER.DCL',
  'SERVER.PLSQL',
];

/**
 * Super administrator: does every command (including the server-side route) AND administers access.
 * It holds the whole catalog, SECURITY.SEGREGATION_OVERRIDE among it, so the separation-of-duties
 * check lets it change policies despite holding writes. This is the one account the owner accepted
 * as exempt; VIEWER / OPERATOR / ADMIN stay segregated.
 */
const SUPER_ADMIN: Permission[] = [...PERMISSIONS];

/**
 * Separation of duties: an account holding any of these may not create, change or delete access
 * policy rules. Otherwise it could relax the rules (WHERE override, four-eyes, row caps) that
 * govern its own writes. The ADMIN role holds none of them. DATA.PREVIEW is not among them: it
 * writes nothing. SUPER_ADMIN holds them all but is exempted by SECURITY.SEGREGATION_OVERRIDE.
 */
export const POLICY_ADMIN_CONFLICTS: readonly Permission[] = [
  'DATA.INSERT',
  'DATA.UPDATE',
  'DATA.DELETE',
  'DDL.CUSTOM.GENERATE',
  'SANKHYA.BUSINESS_ACTION.EXECUTE',
  'SANKHYA.ACTION.CANCELAR_NOTA',
  'SANKHYA.ACTION.INCLUIR_NOTA',
  'SANKHYA.ACTION.INCLUIR_ALTERAR_ITEM_NOTA',
  'SANKHYA.ACTION.EXCLUIR_ITEM_NOTA',
  ...SERVER,
];

/** Permissions of the seeded system roles. The RBAC migration mirrors them; a test keeps both equal. */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  VIEWER,
  OPERATOR,
  ADMIN,
  SUPER_ADMIN,
};

export type StatementKind =
  'SELECT' | 'SHOW' | 'DESCRIBE' | 'EXPLAIN' | 'INSERT' | 'UPDATE' | 'DELETE';
export type WriteKind = Extract<StatementKind, 'INSERT' | 'UPDATE' | 'DELETE'>;

/** The permission a statement kind needs. */
export function statementPermission(kind: StatementKind): Permission {
  switch (kind) {
    case 'INSERT':
      return 'DATA.INSERT';
    case 'UPDATE':
      return 'DATA.UPDATE';
    case 'DELETE':
      return 'DATA.DELETE';
    default:
      return 'QUERY.SELECT';
  }
}

export function isWriteKind(kind: StatementKind): kind is WriteKind {
  return kind === 'INSERT' || kind === 'UPDATE' || kind === 'DELETE';
}
