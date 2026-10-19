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
import { AppError } from '@dbx/shared';

type Redactor = (value: unknown) => unknown;

const MAX_STATEMENT_CHARS = 20_000;
const MAX_ERROR_CHARS = 2_000;

function clip(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

// ---------------------------------------------------------------- audit

export interface AuditFilters {
  action?: string;
  userEmail?: string;
  resource?: string;
  status?: string;
  from?: Date;
  to?: Date;
  limit: number;
  offset: number;
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
      ...event,
      statement: clip(r(event.statement) ?? null, MAX_STATEMENT_CHARS),
      errorMessage: clip(r(event.errorMessage) ?? null, MAX_ERROR_CHARS),
      targetIds: r(event.targetIds),
      before: r(event.before),
      after: r(event.after),
      gatewayCalls: r(event.gatewayCalls),
      details: r(event.details),
    });
  }

  async list(filters: AuditFilters): Promise<{ items: AuditEventRow[]; total: number }> {
    const conditions: SQL[] = [];
    if (filters.action) conditions.push(eq(auditEvents.action, filters.action));
    if (filters.userEmail)
      conditions.push(ilike(auditEvents.userEmail, `%${escapeLike(filters.userEmail)}%`));
    if (filters.resource) conditions.push(eq(auditEvents.resource, filters.resource));
    if (filters.status)
      conditions.push(eq(auditEvents.status, filters.status as AuditEventRow['status']));
    if (filters.from) conditions.push(gte(auditEvents.createdAt, filters.from));
    if (filters.to) conditions.push(lte(auditEvents.createdAt, filters.to));
    const where = conditions.length ? and(...conditions) : undefined;
    const [items, totals] = await Promise.all([
      this.db
        .select()
        .from(auditEvents)
        .where(where)
        .orderBy(desc(auditEvents.createdAt))
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
