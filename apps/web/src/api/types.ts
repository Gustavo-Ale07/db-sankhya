// Response shapes of the DB-Sankhya API (apps/api). Kept local so the browser bundle
// never pulls server-side packages.

/** Mirror of the server permission catalog (packages/shared/src/permissions.ts). */
export type Permission =
  | 'QUERY.SELECT'
  | 'TEMP.CREATE'
  | 'TEMP.WRITE'
  | 'TEMP.DROP'
  | 'TEMP.MATERIALIZE'
  | 'DATA.INSERT'
  | 'DATA.UPDATE'
  | 'DATA.DELETE'
  | 'DDL.CUSTOM.GENERATE'
  | 'SANKHYA.BUSINESS_ACTION.EXECUTE'
  | 'APPROVAL.DECIDE'
  | 'AUDIT.READ'
  | 'ADMIN.USERS'
  | 'ADMIN.GROUPS'
  | 'ADMIN.ROLES'
  | 'ADMIN.POLICIES'
  | 'ADMIN.CONNECTIONS'
  | 'ADMIN.SECURITY';
/** Role keys seeded by the server; administrators may add custom roles. */
export const SYSTEM_ROLES = ['VIEWER', 'OPERATOR', 'ADMIN'] as const;
export type Value = string | number | boolean | null;

export interface User {
  id: string;
  email: string;
  name: string;
  /** Effective roles: assigned directly or through an active group. */
  roles: string[];
  /** Effective permissions; the UI gates on these, never on role names. */
  permissions: Permission[];
  active: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

/** A user as the admin API returns it. */
export interface AdminUser extends User {
  /** Roles assigned to the user directly (not through groups). */
  directRoles: string[];
  groupIds: string[];
}

export interface RoleInfo {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  permissions: Permission[];
}

export interface SessionInfo {
  user: User;
  expiresAt: string;
}

export interface Meta {
  name: string;
  version: string;
  commit: string;
  /** Mode of the Sankhya gateway connections: `mock` serves fictitious data. */
  sankhyaMode: 'mock' | 'live';
  /** The server runs on fictitious data only (DEMO_MODE). */
  demoMode: boolean;
}

export type ConnectionEnvironment = 'PRODUCTION' | 'HOMOLOGATION' | 'SANDBOX';

/** A selectable connection (GET /api/connections): never credentials or URLs. */
export interface ConnectionOption {
  id: string;
  name: string;
  environment: ConnectionEnvironment;
}

/** A column of the Sankhya data dictionary (GET /api/schema). */
export interface CatalogColumn {
  name: string;
  type: string;
  description?: string;
  nullable?: boolean;
  pk: boolean;
}

export interface CatalogForeignKey {
  column: string;
  refTable: string;
  refColumn: string;
}

export interface CatalogTable {
  name: string;
  description?: string;
  entityName?: string;
  columns: CatalogColumn[];
  foreignKeys: CatalogForeignKey[];
}

export interface Catalog {
  tables: CatalogTable[];
  fetchedAt: string;
  source: 'dictionary';
  /** Set when part of the dictionary could not be read: the catalog is incomplete. */
  degraded?: string[];
}

export interface SchemaResponse {
  connectionId: string;
  catalog: Catalog;
}

export interface ResultColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  type: 'result';
  executionId: string;
  connectionId: string;
  kind: string;
  resource: string | null;
  columns: ResultColumn[];
  rows: Value[][];
  rowCount: number;
  truncated: boolean;
  apiCalls: number;
  durationMs: number;
  messages: string[];
}

export interface HistoryItem {
  id: string;
  executionId: string;
  sql: string;
  status: 'success' | 'error' | 'cancelled' | 'preview';
  operation: string | null;
  resource: string | null;
  durationMs: number | null;
  resultRows: number | null;
  affectedRows: number | null;
  apiCalls: number | null;
  errorCode: string | null;
  createdAt: string;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  createdAt: string;
  userId: string | null;
  userEmail: string | null;
  ip: string | null;
  requestId: string | null;
  action: string;
  operation: string | null;
  resource: string | null;
  statement: string | null;
  targetIds: unknown;
  before: unknown;
  after: unknown;
  gatewayCalls: unknown;
  status: 'success' | 'partial' | 'failed' | 'denied' | 'info';
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  details: unknown;
}

export interface SystemStatus {
  version: string;
  commit: string;
  environment: string;
  uptimeSeconds: number;
  database: { status: 'ok' | 'error'; kind: string };
  sankhya: {
    state: 'READY' | 'NOT_CONFIGURED';
    mode: 'mock' | 'live';
    readyConnections: number;
  };
  writes: {
    safeMode: boolean;
    /** Effective kill switch: env GLOBAL_WRITE_ENABLED AND the runtime switch. */
    globalWriteEnabled: boolean;
    globalWrite: { env: boolean; runtime: boolean; effective: boolean };
    writeToSankhya: boolean;
    /** Sankhya writes pass the switches (PRODUCTION connections only with SAFE_MODE off). */
    available: boolean;
    productionAvailable: boolean;
    scratchAvailable: boolean;
  };
  limits: { maxRows: number; timeoutMs: number };
  roles: string[];
  permissions: Permission[];
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  memberIds: string[];
  roleKeys: string[];
}

export type PolicyEffect = 'ALLOW' | 'DENY';
export type PolicySubjectType = 'user' | 'group' | 'everyone';

export interface PolicyLimits {
  maxReadRows?: number;
  maxWriteRows?: number;
  requireWhere?: boolean;
  requirePreview?: boolean;
  requireConfirmation?: boolean;
  requireStrongConfirmation?: boolean;
  requireApproval?: boolean;
  /** false: the audit keeps no before/after row values of writes. */
  auditSnapshots?: boolean;
}

export interface PolicyRule {
  id: string;
  name: string;
  effect: PolicyEffect;
  subjectType: PolicySubjectType;
  subjectId: string | null;
  environments: ConnectionEnvironment[];
  connectionIds: string[];
  actions: string[];
  entities: string[];
  columns: string[];
  limits: PolicyLimits;
  overrideWhereRequired: boolean;
  enabled: boolean;
  updatedAt: string;
}

/** An admin view of a connection: secrets only as states, never values. */
export interface AdminConnection {
  id: string;
  name: string;
  environment: ConnectionEnvironment;
  mode: 'live' | 'mock';
  baseUrl: string;
  dialect: 'oracle' | 'mssql';
  enabled: boolean;
  source: 'env' | 'database';
  editable: boolean;
  status: 'READY' | 'NOT_CONFIGURED' | 'DISABLED';
  secrets: { clientId: string; clientSecret: 'SET' | 'NOT_SET'; xToken: 'SET' | 'NOT_SET' };
  secretsRotatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GlobalWriteState {
  env: boolean;
  runtime: boolean;
  effective: boolean;
}
