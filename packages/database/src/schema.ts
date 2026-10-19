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
    /** Which identity provider owns this account's credentials ('local' = password in this table). */
    identityProvider: text('identity_provider').notNull().default('local'),
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

export const PLAN_STATUSES = ['PENDING', 'APPROVED', 'CONSUMED', 'EXPIRED', 'INVALIDATED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/**
 * Immutable execution plan behind each mutation confirmation token (single use, short-lived).
 * Only `status`, `consumed_at` and `idempotency_key` ever change; `plan_hash` binds the content.
 * `connection_id` is a saved connection's uuid or the env connection id, so it has no foreign key.
 */
export const plans = pgTable(
  'plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    connectionId: text('connection_id').notNull(),
    environment: text('environment', {
      enum: ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'],
    }).notNull(),
    sql: text('sql').notNull(),
    sqlHash: text('sql_hash').notNull(),
    paramsHash: text('params_hash').notNull(),
    capability: jsonb('capability').$type<unknown>().notNull(),
    decision: jsonb('decision').$type<unknown>().notNull(),
    policyVersion: text('policy_version').notNull(),
    /** Before snapshot of every target (keys plus values). */
    targets: jsonb('targets').$type<unknown>().notNull(),
    targetsHash: text('targets_hash').notNull(),
    preview: jsonb('preview').$type<unknown>().notNull(),
    previewKind: text('preview_kind').notNull(),
    planHash: text('plan_hash').notNull(),
    requiresApproval: boolean('requires_approval').notNull().default(false),
    strongConfirmationPhrase: text('strong_confirmation_phrase'),
    status: text('status', { enum: PLAN_STATUSES }).notNull().default('PENDING'),
    /** Set by the consume that used the plan, so a retry with the same key gets the same row. */
    idempotencyKey: text('idempotency_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    index('plans_user_idx').on(t.userId),
    index('plans_connection_status_idx').on(t.connectionId, t.status),
    uniqueIndex('plans_user_idempotency_key').on(t.userId, t.idempotencyKey),
    check(
      'plans_status_check',
      sql`${t.status} in ('PENDING', 'APPROVED', 'CONSUMED', 'EXPIRED', 'INVALIDATED')`,
    ),
    check(
      'plans_environment_check',
      sql`${t.environment} in ('PRODUCTION', 'HOMOLOGATION', 'SANDBOX')`,
    ),
    check('plans_consumed_check', sql`(${t.status} = 'CONSUMED') = (${t.consumedAt} is not null)`),
  ],
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

/**
 * Access policy rules evaluated by `evaluatePolicy` (packages/shared). Empty `environments`,
 * `connection_ids` and `entities` mean "all". The API validates every rule on save and again on
 * load; an invalid enabled rule makes every policy-evaluated action fail closed.
 */
export const policies = pgTable(
  'policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    effect: text('effect', { enum: ['ALLOW', 'DENY'] }).notNull(),
    subjectType: text('subject_type', { enum: ['user', 'group', 'everyone'] }).notNull(),
    /** User or group id; null for `everyone`. */
    subjectId: uuid('subject_id'),
    environments: text('environments')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    connectionIds: uuid('connection_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /** Permissions or permission globs (`DATA.*`). */
    actions: text('actions').array().notNull(),
    /** Entity globs (`TGF*`, `SCHEMA.TABLE`). */
    entities: text('entities')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    columns: text('columns')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    limits: jsonb('limits').$type<Record<string, unknown>>().notNull().default({}),
    overrideWhereRequired: boolean('override_where_required').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('policies_effect_check', sql`${t.effect} in ('ALLOW', 'DENY')`),
    check('policies_subject_type_check', sql`${t.subjectType} in ('user', 'group', 'everyone')`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type SavedQueryRow = typeof savedQueries.$inferSelect;
export type QueryHistoryRow = typeof queryHistory.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
export type PlanRow = typeof plans.$inferSelect;
export type NewPlanRow = typeof plans.$inferInsert;
export type MetadataCacheRow = typeof metadataCache.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type PolicyRow = typeof policies.$inferSelect;
export type NewPolicy = typeof policies.$inferInsert;
