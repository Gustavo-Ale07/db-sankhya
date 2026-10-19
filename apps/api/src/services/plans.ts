import { and, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { plans } from '@dbx/database';
import type { Database, PlanRow } from '@dbx/database';
import { AppError, ENVIRONMENTS, canonicalJSON } from '@dbx/shared';
import type { Environment, PolicyDecision } from '@dbx/shared';
import type { Capability } from '@dbx/sql-engine';
import { hmac, safeEqual, sha256Hex } from '../security/crypto';

export type { PlanRow };

/** Everything a mutation plan freezes. The service derives every hash from this content. */
export interface NewPlan {
  userId: string;
  /** Stable id of the session that previewed the plan (`sessions.id`); the token is bound to it. */
  sessionId: string;
  connectionId: string;
  environment: Environment;
  sql: string;
  /** Bound parameters; only their hash is stored. */
  params: unknown;
  capability: Capability;
  decision: PolicyDecision;
  /** Before snapshot of every target (keys plus values). */
  targets: unknown;
  preview: unknown;
  previewKind: string;
  /** Words of the strong confirmation phrase, e.g. UPDATE / 3 / TGFPAR. */
  summary: { action: string; count: number; entity: string };
}

export interface ConsumePlanInput {
  id: string;
  token: string;
  userId: string;
  sessionId: string;
  strongConfirmation?: string;
  idempotencyKey?: string;
}

export interface CreatedPlan {
  id: string;
  token: string;
  planHash: string;
  expiresAt: Date;
}

export interface PlansOptions {
  /** SESSION_SECRET (AUTH_SECRET): signs plan tokens. */
  secret: string;
  /** PLAN_TTL_SECONDS. */
  ttlSeconds: number;
  /** Clock used for created_at / expires_at (tests). Expiry itself is checked with the database clock. */
  now?: () => Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** `<plan uuid>.<base64url HMAC-SHA256>` */
const TOKEN = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/;
const PHRASE_WORD = /^[A-Z][A-Z0-9_]{0,127}$/;
const LIVE_STATUSES = ['PENDING', 'APPROVED'] as const;

/** `"<ENVIRONMENT> <ACTION> <N> <ENTITY>"`, for example `PRODUCTION UPDATE 3 TGFPAR`. */
export function strongConfirmationPhrase(
  environment: Environment,
  action: string,
  count: number,
  entity: string,
): string {
  return `${environment} ${action.toUpperCase()} ${count} ${entity.toUpperCase()}`;
}

/** Round-trips through JSON, so what is hashed is exactly what jsonb stores and returns. */
function plain(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  return text === undefined ? null : (JSON.parse(text) as unknown);
}

const hashOf = (value: unknown) => sha256Hex(canonicalJSON(value));

function planHashOf(p: {
  sqlHash: string;
  paramsHash: string;
  userId: string;
  connectionId: string;
  environment: string;
  policyVersion: string;
  targetsHash: string;
  capability: unknown;
}): string {
  return hashOf({
    sqlHash: p.sqlHash,
    paramsHash: p.paramsHash,
    userId: p.userId,
    connectionId: p.connectionId,
    environment: p.environment,
    policyVersion: p.policyVersion,
    targetsHash: p.targetsHash,
    capability: p.capability,
  });
}

const invalid = () =>
  new AppError('CONFIRMATION_INVALID', 'Invalid confirmation. Generate a new preview.');
const expired = () =>
  new AppError('CONFIRMATION_EXPIRED', 'The confirmation expired. Generate a new preview.');
const used = () => new AppError('CONFIRMATION_USED', 'This confirmation was already used.');
const badInput = (message: string) => new AppError('VALIDATION_ERROR', message);

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Immutable, hashed execution plans (Task 11.1). A plan freezes the statement, its targets, the
 * capability and the policy decision; `plan_hash` binds them and the token binds the plan to the
 * session that previewed it. `consume` is a single conditional UPDATE, so a plan runs at most once.
 */
export class PlansService {
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly options: PlansOptions,
  ) {
    if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0)
      throw new Error('PlansService: ttlSeconds must be a positive integer');
    if (!options.secret) throw new Error('PlansService: secret is required');
    this.now = options.now ?? (() => new Date());
  }

  async create(input: NewPlan): Promise<CreatedPlan> {
    this.validate(input);
    if (
      input.decision.effect !== 'ALLOW' ||
      input.capability.class === 'UNSUPPORTED' ||
      input.capability.route === 'NONE' ||
      input.capability.blocked
    ) {
      throw new AppError('FORBIDDEN', 'This statement cannot be planned.');
    }

    const capability = plain(input.capability);
    const targets = plain(input.targets);
    const sqlHash = sha256Hex(input.sql);
    const paramsHash = hashOf(plain(input.params));
    const targetsHash = hashOf(targets);
    const policyVersion = input.decision.policyVersion;
    const planHash = planHashOf({
      sqlHash,
      paramsHash,
      userId: input.userId,
      connectionId: input.connectionId,
      environment: input.environment,
      policyVersion,
      targetsHash,
      capability,
    });
    const limits = input.decision.limits;
    const needsPhrase = limits.requireStrongConfirmation || input.environment === 'PRODUCTION';
    const { action, count, entity } = input.summary;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.options.ttlSeconds * 1000);

    const [row] = await this.db
      .insert(plans)
      .values({
        userId: input.userId,
        sessionId: input.sessionId,
        connectionId: input.connectionId,
        environment: input.environment,
        sql: input.sql,
        sqlHash,
        paramsHash,
        capability,
        decision: plain(input.decision),
        policyVersion,
        targets,
        targetsHash,
        preview: plain(input.preview),
        previewKind: input.previewKind,
        planHash,
        requiresApproval: limits.requireApproval,
        strongConfirmationPhrase: needsPhrase
          ? strongConfirmationPhrase(input.environment, action, count, entity)
          : null,
        createdAt,
        expiresAt,
      })
      .returning({ id: plans.id });
    const id = row!.id;
    return { id, token: `${id}.${this.mac(id, planHash, input.sessionId)}`, planHash, expiresAt };
  }

  /**
   * Marks the plan CONSUMED and returns it, or throws CONFIRMATION_INVALID / _EXPIRED / _USED.
   * Nobody without a valid token for this user and session learns anything beyond INVALID.
   */
  async consume(input: ConsumePlanInput): Promise<PlanRow> {
    const match = TOKEN.exec(input.token);
    if (!match || match[1] !== input.id || !UUID.test(input.id)) throw invalid();
    if (!UUID.test(input.userId) || !UUID.test(input.sessionId)) throw invalid();
    const key = input.idempotencyKey;
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) throw invalid();

    const [row] = await this.db.select().from(plans).where(eq(plans.id, input.id)).limit(1);
    if (
      !row ||
      row.userId !== input.userId ||
      row.sessionId !== input.sessionId ||
      !safeEqual(match[2]!, this.mac(row.id, row.planHash, input.sessionId)) ||
      !this.intact(row)
    ) {
      throw invalid();
    }
    if (key !== undefined) {
      if (row.status === 'CONSUMED' && row.idempotencyKey === key) return row;
      const [holder] = await this.db
        .select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.userId, input.userId), eq(plans.idempotencyKey, key)))
        .limit(1);
      if (holder && holder.id !== row.id) throw invalid();
    }

    let consumed: PlanRow | undefined;
    try {
      [consumed] = await this.db
        .update(plans)
        .set({
          status: 'CONSUMED',
          consumedAt: sql`now()`,
          ...(key !== undefined ? { idempotencyKey: key } : {}),
        })
        .where(
          and(
            eq(plans.id, row.id),
            eq(plans.userId, input.userId),
            eq(plans.sessionId, input.sessionId),
            eq(plans.planHash, row.planHash),
            inArray(plans.status, [...LIVE_STATUSES]),
            or(eq(plans.status, 'APPROVED'), eq(plans.requiresApproval, false)),
            gt(plans.expiresAt, sql`now()`),
            or(
              isNull(plans.strongConfirmationPhrase),
              eq(plans.strongConfirmationPhrase, input.strongConfirmation ?? ''),
            ),
          ),
        )
        .returning();
    } catch (err) {
      // The idempotency key was taken by another plan in the meantime.
      if (isUniqueViolation(err)) throw invalid();
      throw err;
    }
    if (consumed) return consumed;
    return this.refusal(row.id, key);
  }

  /** Invalidates the live plans of a connection (secrets rotated, environment changed...). */
  async invalidateForConnection(connectionId: string): Promise<number> {
    const rows = await this.db
      .update(plans)
      .set({ status: 'INVALIDATED' })
      .where(and(eq(plans.connectionId, connectionId), inArray(plans.status, [...LIVE_STATUSES])))
      .returning({ id: plans.id });
    return rows.length;
  }

  /**
   * Why the conditional UPDATE matched nothing, for a caller who holds a valid token. Returns the
   * row only for an idempotent retry that raced the consume carrying the same key.
   */
  private async refusal(id: string, key: string | undefined): Promise<PlanRow> {
    const [current] = await this.db
      .select({ row: plans, expired: sql<boolean>`${plans.expiresAt} <= now()` })
      .from(plans)
      .where(eq(plans.id, id))
      .limit(1);
    if (!current) throw invalid();
    const { row } = current;
    if (row.status === 'CONSUMED') {
      if (key !== undefined && row.idempotencyKey === key) return row;
      throw used();
    }
    if (row.status === 'EXPIRED') throw expired();
    if (current.expired && (row.status === 'PENDING' || row.status === 'APPROVED')) {
      await this.db
        .update(plans)
        .set({ status: 'EXPIRED' })
        .where(
          and(
            eq(plans.id, id),
            inArray(plans.status, [...LIVE_STATUSES]),
            lte(plans.expiresAt, sql`now()`),
          ),
        );
      throw expired();
    }
    throw invalid();
  }

  private mac(id: string, planHash: string, sessionId: string): string {
    return hmac(this.options.secret, `plan|${id}|${planHash}|${sessionId}`);
  }

  /** Recomputes every derivable hash, so an altered row is never executed. */
  private intact(row: PlanRow): boolean {
    const sqlHash = sha256Hex(row.sql);
    const targetsHash = hashOf(row.targets);
    if (sqlHash !== row.sqlHash || targetsHash !== row.targetsHash) return false;
    return (
      planHashOf({
        sqlHash,
        paramsHash: row.paramsHash,
        userId: row.userId,
        connectionId: row.connectionId,
        environment: row.environment,
        policyVersion: row.policyVersion,
        targetsHash,
        capability: row.capability,
      }) === row.planHash
    );
  }

  private validate(input: NewPlan): void {
    if (!UUID.test(input.userId)) throw badInput('userId must be a uuid');
    if (!UUID.test(input.sessionId)) throw badInput('sessionId must be a uuid');
    if (!input.connectionId || input.connectionId.length > 100)
      throw badInput('connectionId is invalid');
    if (!(ENVIRONMENTS as readonly string[]).includes(input.environment))
      throw badInput('environment is invalid');
    if (typeof input.sql !== 'string' || input.sql.trim() === '') throw badInput('sql is required');
    if (!input.previewKind || input.previewKind.length > 64)
      throw badInput('previewKind is invalid');
    if (!input.decision.policyVersion) throw badInput('policyVersion is required');
    const { action, count, entity } = input.summary;
    if (
      !PHRASE_WORD.test(action.toUpperCase()) ||
      !PHRASE_WORD.test(entity.toUpperCase()) ||
      !Number.isSafeInteger(count) ||
      count < 0
    ) {
      throw badInput('summary is invalid');
    }
  }
}
