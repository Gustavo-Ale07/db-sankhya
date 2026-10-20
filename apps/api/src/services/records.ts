import { and, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { auditEvents, queryHistory, savedQueries } from '@dbx/database';
import type {
  AuditEventRow,
  Database,
  NewAuditEvent,
  QueryHistoryRow,
  SavedQueryRow,
} from '@dbx/database';
import { AppError, jsonbSafe, redactBroad, redactSnapshotPair } from '@dbx/shared';
import type { Environment } from '@dbx/shared';

type Redactor = (value: unknown) => unknown;

const MAX_STATEMENT_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;

/** Broad (contains-match) key redaction for audit JSON columns; null/undefined pass through. */
function broad<T>(value: T, clipStrings = false): T {
  return value === undefined || value === null ? value : (redactBroad(value, { clipStrings }) as T);
}

function normalize(value: string | null | undefined): string | null | undefined {
  return typeof value === 'string' ? jsonbSafe(value) : value;
}

/**
 * Copies `event` with every top-level string (userEmail, ip, requestId, action, operation,
 * resource, errorCode, connectionId, environment, planHash, capability and any column added
 * later) made storable: PostgreSQL text rejects NUL and lone surrogates would be mangled.
 */
function normalizeText<T extends object>(event: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = typeof value === 'string' ? jsonbSafe(value) : value;
  }
  return out as T;
}

/** Makes text storable (no NUL, no lone surrogate) and clips it to `max` characters. */
function clip(raw: string | null | undefined, max: number): string | null {
  if (raw === null || raw === undefined) return null;
  const value = jsonbSafe(raw);
  if (value.length <= max) return value;
  let head = value.slice(0, max);
  // Never leave half of a surrogate pair at the cut.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}…`;
}

// ---------------------------------------------------------------- audit

export const AUDIT_STATUSES = ['success', 'partial', 'failed', 'denied', 'info'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

/** Mutation-plan lifecycle events. The mutation orchestrator emits them through AuditService. */
export const AUDIT_LIFECYCLE_ACTIONS = [
  'PLAN_CREATED',
  'PLAN_EXECUTED',
  'PLAN_DENIED',
  'VERIFICATION',
] as const;
export type AuditLifecycleAction = (typeof AUDIT_LIFECYCLE_ACTIONS)[number];

export interface AuditFilters {
  action?: string;
  userId?: string;
  userEmail?: string;
  resource?: string;
  status?: AuditStatus;
  environment?: Environment;
  connectionId?: string;
  planId?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
}

/** Who acted, where, and on which plan: shared by every lifecycle event. */
export interface AuditLifecycleContext {
  userId?: string | null;
  userEmail?: string | null;
  ip?: string | null;
  requestId?: string | null;
  connectionId: string;
  environment: Environment;
  planId: string;
  planHash?: string | null;
  capability?: string | null;
  approvalId?: string | null;
}

type SnapshotRows = readonly Record<string, unknown>[];

interface LifecycleCommon {
  statement?: string | null;
  policyDecision?: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  /**
   * The policy limit `auditSnapshots` (default true; any matching rule setting it false wins),
   * resolved by the caller from the decision. When false, no before/after rows are stored.
   */
  auditSnapshots?: boolean;
  before?: SnapshotRows;
  after?: SnapshotRows;
}

export class AuditService {
  constructor(
    private readonly db: Database,
    private readonly redactor: Redactor,
  ) {}

  /** Every JSON field is passed through the redactor; secrets never reach the audit table. */
  async record(event: NewAuditEvent): Promise<void> {
    const r = <T>(v: T): T => (v === undefined || v === null ? v : (this.redactor(v) as T));
    await this.db.insert(auditEvents).values({
      ...normalizeText(event),
      // Normalize (NUL, lone surrogates) before the redactor, so NUL cannot split a secret
      // past it; clip() normalizes again, which is a no-op by then.
      statement: clip(r(normalize(event.statement)) ?? null, MAX_STATEMENT_CHARS),
      errorMessage: clip(r(normalize(event.errorMessage)) ?? null, MAX_ERROR_CHARS),
      // Audit JSON gets the broad matcher: any key containing a sensitive word, at any depth.
      // Row-shaped columns also get their strings clipped (2000 chars).
      targetIds: r(broad(event.targetIds, true)),
      before: r(broad(event.before, true)),
      after: r(broad(event.after, true)),
      gatewayCalls: r(broad(event.gatewayCalls, true)),
      details: r(broad(event.details)),
      verification: r(broad(event.verification)),
      policyDecision: r(broad(event.policyDecision)),
      snapshot: r(broad(event.snapshot)),
    });
  }

  /** A mutation plan was built (status `info`); `before` holds the rows it would change. */
  recordPlanCreated(ctx: AuditLifecycleContext, input: LifecycleCommon): Promise<void> {
    return this.recordLifecycle('PLAN_CREATED', 'info', ctx, input);
  }

  /** A plan ran; `outcome` is the execution result, `before`/`after` the affected rows. */
  recordPlanExecuted(
    ctx: AuditLifecycleContext,
    input: LifecycleCommon & {
      outcome: 'success' | 'partial' | 'failed';
      affectedRows?: number;
      durationMs?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    const { outcome, affectedRows, durationMs, errorCode, errorMessage, ...rest } = input;
    return this.recordLifecycle('PLAN_EXECUTED', outcome, ctx, {
      ...rest,
      details: {
        ...(rest.details ?? {}),
        ...(affectedRows !== undefined ? { affectedRows } : {}),
      },
      durationMs,
      errorCode,
      errorMessage,
    });
  }

  /** The policy engine (or an approval) refused a plan. */
  recordPlanDenied(
    ctx: AuditLifecycleContext,
    input: LifecycleCommon & { errorCode?: string | null; errorMessage?: string | null },
  ): Promise<void> {
    return this.recordLifecycle('PLAN_DENIED', 'denied', ctx, input);
  }

  /** The post-execution check: `success` when it passed, `failed` otherwise. */
  recordVerification(
    ctx: AuditLifecycleContext,
    input: LifecycleCommon & { passed: boolean; verification?: Record<string, unknown> },
  ): Promise<void> {
    const { passed, verification, ...rest } = input;
    return this.recordLifecycle('VERIFICATION', passed ? 'success' : 'failed', ctx, {
      ...rest,
      verification: { ...(verification ?? {}), passed },
    });
  }

  private async recordLifecycle(
    action: AuditLifecycleAction,
    status: AuditStatus,
    ctx: AuditLifecycleContext,
    input: LifecycleCommon & {
      verification?: Record<string, unknown>;
      durationMs?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
  ): Promise<void> {
    const snapshotsOn = input.auditSnapshots ?? true;
    const hasRows = input.before !== undefined || input.after !== undefined;
    let snapshot: Record<string, unknown> | null = null;
    if (snapshotsOn && hasRows) {
      // One 256 KB budget per audit row, shared by before and after.
      snapshot = { ...redactSnapshotPair({ before: input.before, after: input.after }) };
    }
    const details: Record<string, unknown> = {
      ...(input.details ?? {}),
      ...(!snapshotsOn && hasRows ? { snapshotsDisabled: true } : {}),
    };
    await this.record({
      action,
      status,
      userId: ctx.userId ?? null,
      userEmail: ctx.userEmail ?? null,
      ip: ctx.ip ?? null,
      requestId: ctx.requestId ?? null,
      connectionId: ctx.connectionId,
      environment: ctx.environment,
      planId: ctx.planId,
      planHash: ctx.planHash ?? null,
      capability: ctx.capability ?? null,
      approvalId: ctx.approvalId ?? null,
      statement: input.statement ?? null,
      policyDecision: input.policyDecision ?? null,
      verification: input.verification ?? null,
      snapshot,
      durationMs: input.durationMs ?? null,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      details: Object.keys(details).length ? details : null,
    });
  }

  async list(filters: AuditFilters): Promise<{ items: AuditEventRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
    if (filters.userId) conditions.push(eq(auditEvents.userId, filters.userId));
    if (filters.userEmail)
      conditions.push(ilike(auditEvents.userEmail, `%${escapeLike(filters.userEmail)}%`));
    if (filters.resource) conditions.push(eq(auditEvents.resource, filters.resource));
    if (filters.status) conditions.push(eq(auditEvents.status, filters.status));
    if (filters.environment) conditions.push(eq(auditEvents.environment, filters.environment));
    if (filters.connectionId) conditions.push(eq(auditEvents.connectionId, filters.connectionId));
    if (filters.planId) conditions.push(eq(auditEvents.planId, filters.planId));
    if (filters.from) conditions.push(gte(auditEvents.createdAt, filters.from));
    if (filters.to) conditions.push(lte(auditEvents.createdAt, filters.to));
    const where = conditions.length ? and(...conditions) : undefined;
    const [items, totals] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(filters.limit)
        .offset(filters.offset),
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(auditEvents)
        .where(where),
    ]);
    return { items, total: totals[0]?.n ?? 0 };
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// ---------------------------------------------------------------- history

export type HistoryEntry = Omit<typeof queryHistory.$inferInsert, 'id' | 'createdAt'>;

export class HistoryService {
  constructor(private readonly db: Database) {}

  async record(entry: HistoryEntry): Promise<void> {
    await this.db
      .insert(queryHistory)
      .values({ ...entry, sql: clip(entry.sql, MAX_STATEMENT_CHARS) ?? '' });
  }

  async list(
    userId: string,
    limit: number,
    offset: number,
    search?: string,
  ): Promise<QueryHistoryRow[]> {
    const conditions: SQL[] = [eq(queryHistory.userId, userId)];
    if (search) conditions.push(ilike(queryHistory.sql, `%${escapeLike(search)}%`));
    return this.db
      .select()
      .from(queryHistory)
      .where(and(...conditions))
      .orderBy(desc(queryHistory.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async clear(userId: string): Promise<void> {
    await this.db.delete(queryHistory).where(eq(queryHistory.userId, userId));
  }
}

// ---------------------------------------------------------------- saved queries

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export class SavedQueriesService {
  constructor(private readonly db: Database) {}

  list(userId: string): Promise<SavedQueryRow[]> {
    return this.db
      .select()
      .from(savedQueries)
      .where(eq(savedQueries.userId, userId))
      .orderBy(savedQueries.name);
  }

  /** Always scoped by owner: another user's id behaves exactly like a missing one (no IDOR oracle). */
  async get(userId: string, id: string): Promise<SavedQueryRow> {
    const [row] = await this.db
      .select()
      .from(savedQueries)
      .where(and(eq(savedQueries.id, id), eq(savedQueries.userId, userId)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'Saved query not found');
    return row;
  }

  async create(
    userId: string,
    input: { name: string; sql: string; description?: string | null },
  ): Promise<SavedQueryRow> {
    try {
      const [row] = await this.db
        .insert(savedQueries)
        .values({
          userId,
          name: input.name.trim(),
          sql: input.sql,
          description: input.description ?? null,
        })
        .returning();
      return row as SavedQueryRow;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError('CONFLICT', 'You already have a saved query with this name');
      throw err;
    }
  }

  async update(
    userId: string,
    id: string,
    patch: { name?: string; sql?: string; description?: string | null },
  ): Promise<SavedQueryRow> {
    await this.get(userId, id);
    try {
      const [row] = await this.db
        .update(savedQueries)
        .set({
          ...patch,
          ...(patch.name ? { name: patch.name.trim() } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(savedQueries.id, id), eq(savedQueries.userId, userId)))
        .returning();
      return row as SavedQueryRow;
    } catch (err) {
      if (isUniqueViolation(err))
        throw new AppError('CONFLICT', 'You already have a saved query with this name');
      throw err;
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    const rows = await this.db
      .delete(savedQueries)
      .where(and(eq(savedQueries.id, id), eq(savedQueries.userId, userId)))
      .returning({ id: savedQueries.id });
    if (rows.length === 0) throw new AppError('NOT_FOUND', 'Saved query not found');
  }

  async duplicate(userId: string, id: string): Promise<SavedQueryRow> {
    const source = await this.get(userId, id);
    const existing = new Set((await this.list(userId)).map((q) => q.name));
    let name = `${source.name} (cópia)`;
    for (let i = 2; existing.has(name); i++) name = `${source.name} (cópia ${i})`;
    return this.create(userId, { name, sql: source.sql, description: source.description });
  }
}
