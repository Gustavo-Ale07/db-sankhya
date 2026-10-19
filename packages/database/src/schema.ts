import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  primaryKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    active: boolean('active').notNull().default(true),
    failedLogins: integer('failed_logins').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_key').on(t.email),
    check('users_email_lower_check', sql`${t.email} = lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** SHA-256 of the opaque cookie token; the token itself is never stored. */
    tokenHash: text('token_hash').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

/** A named bundle of permissions. `system` roles are seeded by migrations and cannot be deleted. */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    system: boolean('system').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('roles_key_key').on(t.key),
    check('roles_key_format_check', sql`${t.key} ~ '^[A-Z][A-Z0-9_]{1,39}$'`),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description'),
    /** A disabled group grants nothing to its members. */
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('groups_name_key').on(t.name)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('group_members_user_idx').on(t.userId),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

export const groupRoles = pgTable(
  'group_roles',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.roleId] })],
);

export const savedQueries = pgTable(
  'saved_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sql: text('sql').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('saved_queries_user_name_key').on(t.userId, t.name)],
);

/** Execution metadata only — result rows are never persisted. */
export const queryHistory = pgTable(
  'query_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    executionId: text('execution_id').notNull(),
    sql: text('sql').notNull(),
    status: text('status', { enum: ['success', 'error', 'cancelled', 'preview'] }).notNull(),
    operation: text('operation'),
    resource: text('resource'),
    durationMs: integer('duration_ms').notNull(),
    resultRows: integer('result_rows'),
    affectedRows: integer('affected_rows'),
    apiCalls: integer('api_calls').notNull().default(0),
    errorCode: text('error_code'),
    createdAt: createdAt(),
  },
  (t) => [index('query_history_user_created_idx').on(t.userId, t.createdAt)],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    createdAt: createdAt(),
    /** Kept even if the user is removed later. */
    userId: uuid('user_id'),
    userEmail: text('user_email'),
    ip: text('ip'),
    requestId: text('request_id'),
    /** e.g. write.execute, write.preview, auth.login, auth.login_failed, user.create */
    action: text('action').notNull(),
    operation: text('operation'),
    resource: text('resource'),
    statement: text('statement'),
    targetIds: jsonb('target_ids').$type<unknown[]>(),
    before: jsonb('before').$type<unknown>(),
    after: jsonb('after').$type<unknown>(),
    /**
     * Redacted summary of the gateway calls made (service, status, duration). Rows written
     * before migration 0004 hold legacy call summaries ({endpoint, call, ...}) from the removed
     * integration.
     */
    gatewayCalls: jsonb('gateway_calls').$type<unknown[]>(),
    status: text('status', { enum: ['success', 'partial', 'failed', 'denied', 'info'] }).notNull(),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    details: jsonb('details').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('audit_events_created_idx').on(t.createdAt),
    index('audit_events_user_idx').on(t.userId),
    index('audit_events_action_idx').on(t.action),
  ],
);

/**
 * Server-side record behind each write confirmation token (single use, short-lived).
 * Unused since Task 5.3; unused until Stage 11 plans replace it.
 */
export const writePreviews = pgTable(
  'write_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    statementHash: text('statement_hash').notNull(),
    targetsHash: text('targets_hash').notNull(),
    operation: text('operation').notNull(),
    resource: text('resource').notNull(),
    targetCount: integer('target_count').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [index('write_previews_user_idx').on(t.userId)],
);

/**
 * Sankhya gateway connections. Credentials are sealed with AES-256-GCM by the API (AAD = id +
 * field name) and never stored or returned in clear text.
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    environment: text('environment', {
      enum: ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'],
    }).notNull(),
    mode: text('mode', { enum: ['live', 'mock'] }).notNull(),
    baseUrl: text('base_url').notNull(),
    dialect: text('dialect', { enum: ['oracle', 'mssql'] }).notNull(),
    clientIdEnc: text('client_id_enc'),
    clientSecretEnc: text('client_secret_enc'),
    xTokenEnc: text('x_token_enc'),
    secretsRotatedAt: timestamp('secrets_rotated_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('connections_name_key').on(t.name),
    check(
      'connections_environment_check',
      sql`${t.environment} in ('PRODUCTION', 'HOMOLOGATION', 'SANDBOX')`,
    ),
    check('connections_mode_check', sql`${t.mode} in ('live', 'mock')`),
    check('connections_dialect_check', sql`${t.dialect} in ('oracle', 'mssql')`),
  ],
);

/**
 * Last data dictionary catalog discovered per connection, so a restart does not pay the discovery
 * cost again. The row goes away with its connection.
 */
export const metadataCache = pgTable('metadata_cache', {
  connectionId: uuid('connection_id')
    .primaryKey()
    .references(() => connections.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').$type<unknown>().notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
});

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type SavedQueryRow = typeof savedQueries.$inferSelect;
export type QueryHistoryRow = typeof queryHistory.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type WritePreviewRow = typeof writePreviews.$inferSelect;
export type MetadataCacheRow = typeof metadataCache.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
