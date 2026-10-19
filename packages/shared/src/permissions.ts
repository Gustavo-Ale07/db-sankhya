/**
 * Permission catalog. Permissions say what a user may attempt; the policy engine, the global
 * write switches and approvals can still refuse it. No permission grants DDL on native ERP
 * tables: that is refused for everyone, administrators included.
 */
export const PERMISSIONS = [
  'QUERY.SELECT',
  'TEMP.CREATE',
  'TEMP.WRITE',
  'TEMP.DROP',
  'TEMP.MATERIALIZE',
  'DATA.INSERT',
  'DATA.UPDATE',
  'DATA.DELETE',
  'DDL.CUSTOM.GENERATE',
  'SANKHYA.BUSINESS_ACTION.EXECUTE',
  'APPROVAL.DECIDE',
  'AUDIT.READ',
  'ADMIN.USERS',
  'ADMIN.GROUPS',
  'ADMIN.ROLES',
  'ADMIN.POLICIES',
  'ADMIN.CONNECTIONS',
  'ADMIN.SECURITY',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const CATALOG: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return CATALOG.has(value);
}

export const SYSTEM_ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

const TEMP: Permission[] = ['TEMP.CREATE', 'TEMP.WRITE', 'TEMP.DROP', 'TEMP.MATERIALIZE'];
const VIEWER: Permission[] = ['QUERY.SELECT', ...TEMP];
const OPERATOR: Permission[] = [...VIEWER, 'DATA.INSERT', 'DATA.UPDATE'];
/**
 * Administers the tool. It gets no DATA.*, DDL.* or SANKHYA.* permission by default: an
 * administrator who must also write ERP data needs an additional role.
 */
const ADMIN: Permission[] = [
  'QUERY.SELECT',
  ...TEMP,
  'APPROVAL.DECIDE',
  'AUDIT.READ',
  'ADMIN.USERS',
  'ADMIN.GROUPS',
  'ADMIN.ROLES',
  'ADMIN.POLICIES',
  'ADMIN.CONNECTIONS',
  'ADMIN.SECURITY',
];

/** Permissions of the seeded system roles. The RBAC migration mirrors them; a test keeps both equal. */
export const SYSTEM_ROLE_PERMISSIONS: Readonly<Record<SystemRole, readonly Permission[]>> = {
  VIEWER,
  OPERATOR,
  ADMIN,
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
