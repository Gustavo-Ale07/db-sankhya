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

/** True when a string anywhere in the JSON value (keys included) holds U+0000. */
function hasNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some(hasNul);
  if (typeof value === 'object' && value !== null)
    return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNul(v));
  return false;
}

/**
 * Round-trips through JSON, so what is hashed is exactly what jsonb stores and returns. PostgreSQL
 * text and jsonb cannot hold U+0000, so such input is refused here instead of failing the insert.
 */
function plain(value: unknown, field: string): unknown {
  const text = JSON.stringify(value ?? null);
  const parsed = text === undefined ? null : (JSON.parse(text) as unknown);
  if (hasNul(parsed)) throw badInput(`${field} must not contain NUL characters`);
  return parsed;
}

const hashOf = (value: unknown) => sha256Hex(canonicalJSON(value));

/** The `params_hash` of a plan, so the executor can re-verify the bound parameters. */
export function paramsHashOf(params: unknown): string {
  return hashOf(plain(params, 'params'));
}

/** Outcome of `consume`. */
export interface ConsumedPlan {
  plan: PlanRow;
  /**
   * True when this call did NOT perform the transition: it is an idempotent replay (same user,
   * plan and key) of a consume that already happened. A replay must never execute the mutation
   * again; the caller (Task 11.2) returns the stored execution result of the original instead.
   */
  replayed: boolean;
}

interface PlanHashInput {
  sqlHash: string;
  paramsHash: string;
  userId: string;
  connectionId: string;
  environment: string;
  policyVersion: string;
  targetsHash: string;
  capability: unknown;
  /** Gate fields (controller ruling, superset of the brief's list). */
  requiresApproval: boolean;
  strongConfirmationPhrase: string | null;
  expiresAt: Date;
  decision: unknown;
  preview: unknown;
  previewKind: string;
}

function planHashOf(p: PlanHashInput): string {
  return hashOf({
    sqlHash: p.sqlHash,
    paramsHash: p.paramsHash,
    userId: p.userId,
    connectionId: p.connectionId,
    environment: p.environment,
    policyVersion: p.policyVersion,
    targetsHash: p.targetsHash,
    capability: p.capability,
    requiresApproval: p.requiresApproval,
    strongConfirmationPhrase: p.strongConfirmationPhrase,
    expiresAt: p.expiresAt.toISOString(),
    decisionHash: hashOf(p.decision),
    previewHash: hashOf(p.preview),
    previewKind: p.previewKind,
  });
}

/** The gates a stored decision and environment imply (re-derived at consume time). */
function gatesOf(
  decision: unknown,
  environment: string,
): { requiresApproval: boolean; needsPhrase: boolean } | undefined {
  const limits = (decision as { limits?: Record<string, unknown> } | null)?.limits;
  if (
    !limits ||
    typeof limits.requireApproval !== 'boolean' ||
    typeof limits.requireStrongConfirmation !== 'boolean'
  )
    return undefined;
  return {
    requiresApproval: limits.requireApproval,
    needsPhrase: limits.requireStrongConfirmation || environment === 'PRODUCTION',
  };
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

    const capability = plain(input.capability, 'capability');
    const targets = plain(input.targets, 'targets');
    const sqlHash = sha256Hex(input.sql);
    const paramsHash = paramsHashOf(input.params);
    const targetsHash = hashOf(targets);
    const decision = plain(input.decision, 'decision');
    const preview = plain(input.preview, 'preview');
    const policyVersion = input.decision.policyVersion;
    const gates = gatesOf(decision, input.environment);
    if (!gates) throw badInput('decision limits are invalid');
    const { action, count, entity } = input.summary;
    if (Array.isArray(targets) && count !== targets.length)
      throw badInput('summary.count must equal the number of targets');
    const phrase = gates.needsPhrase
      ? strongConfirmationPhrase(input.environment, action, count, entity)
      : null;
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.options.ttlSeconds * 1000);
    const planHash = planHashOf({
      sqlHash,
      paramsHash,
      userId: input.userId,
      connectionId: input.connectionId,
      environment: input.environment,
      policyVersion,
      targetsHash,
      capability,
      requiresApproval: gates.requiresApproval,
      strongConfirmationPhrase: phrase,
      expiresAt,
      decision,
      preview,
      previewKind: input.previewKind,
    });

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
        decision,
        policyVersion,
        targets,
        targetsHash,
        preview,
        previewKind: input.previewKind,
        planHash,
        requiresApproval: gates.requiresApproval,
        strongConfirmationPhrase: phrase,
        createdAt,
        expiresAt,
      })
      .returning({ id: plans.id });
    const id = row!.id;
    return { id, token: `${id}.${this.mac(id, planHash, input.sessionId)}`, planHash, expiresAt };
  }

  /**
   * Marks the plan CONSUMED, or throws CONFIRMATION_INVALID / _EXPIRED / _USED. Nobody without a
   * valid token for this user and session learns anything beyond INVALID.
   *
   * Only the call that performs the PENDING/APPROVED → CONSUMED transition gets
   * `replayed: false` and may execute the mutation. A retry with the same idempotency key gets the
   * same row with `replayed: true`: it must never execute the mutation again (Task 11.2 answers it
   * with the stored execution result of the original call).
   */
  async consume(input: ConsumePlanInput): Promise<ConsumedPlan> {
    const raw = input as unknown as Record<string, unknown>;
    if (
      typeof raw.token !== 'string' ||
      typeof raw.id !== 'string' ||
      typeof raw.userId !== 'string' ||
      typeof raw.sessionId !== 'string' ||
      (raw.idempotencyKey !== undefined && typeof raw.idempotencyKey !== 'string') ||
      (raw.strongConfirmation !== undefined && typeof raw.strongConfirmation !== 'string')
    )
      throw invalid();
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
      if (row.status === 'CONSUMED' && row.idempotencyKey === key)
        return { plan: row, replayed: true };
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
    if (consumed) return { plan: consumed, replayed: false };
    return { plan: await this.refusal(row.id, key), replayed: true };
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
   * row only for an idempotent retry that raced the consume carrying the same key (a replay).
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

  /**
   * Recomputes every derivable hash and re-derives the gates from the stored decision and
   * environment, so an altered row (content or gate columns) is never executed.
   */
  private intact(row: PlanRow): boolean {
    const sqlHash = sha256Hex(row.sql);
    const targetsHash = hashOf(row.targets);
    if (sqlHash !== row.sqlHash || targetsHash !== row.targetsHash) return false;
    const decision = row.decision as { policyVersion?: unknown } | null;
    if (decision?.policyVersion !== row.policyVersion) return false;
    const gates = gatesOf(row.decision, row.environment);
    if (
      !gates ||
      gates.requiresApproval !== row.requiresApproval ||
      gates.needsPhrase !== (row.strongConfirmationPhrase !== null) ||
      (row.strongConfirmationPhrase !== null &&
        !row.strongConfirmationPhrase.startsWith(`${row.environment} `))
    )
      return false;
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
        requiresApproval: row.requiresApproval,
        strongConfirmationPhrase: row.strongConfirmationPhrase,
        expiresAt: row.expiresAt,
        decision: row.decision,
        preview: row.preview,
        previewKind: row.previewKind,
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
    if (
      [input.sql, input.connectionId, input.previewKind].some(
        (s) => typeof s !== 'string' || s.includes('\u0000'),
      )
    )
      throw badInput('text fields must not contain NUL characters');
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
