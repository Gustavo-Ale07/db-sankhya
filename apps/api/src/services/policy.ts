import { asc, eq, sql } from 'drizzle-orm';
import { policies } from '@dbx/database';
import type { Database, PolicyRow } from '@dbx/database';
import {
  AppError,
  DEFAULT_LIMITS,
  evaluatePolicy,
  policyVersion,
  validatePolicyRule,
} from '@dbx/shared';
import type {
  Environment,
  EvaluateOptions,
  Permission,
  PolicyDecision,
  PolicyRequest,
  PolicyRule,
} from '@dbx/shared';

/** A rule as created by an admin: everything but the id, which the database assigns. */
export type PolicyInput = Omit<PolicyRule, 'id'>;
export type PolicyPatch = Partial<PolicyInput>;

/** A stored rule, as listed to admins. */
export type PolicyRecord = PolicyRule & { updatedAt: string };

/**
 * The cached rule set. `rules` holds every stored rule, disabled and invalid ones included, so
 * `version` covers them all and `evaluatePolicy` sees the same set (it denies everything while any
 * enabled rule is invalid). `invalid` describes those invalid enabled rules: non-empty means every
 * policy-evaluated action is denied until an admin fixes them.
 */
export interface PolicySnapshot {
  rules: PolicyRule[];
  version: string;
  invalid: string[];
}

export interface PolicyLogger {
  error(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME = 200;
const INPUT_KEYS = [
  'name',
  'effect',
  'subjectType',
  'subjectId',
  'environments',
  'connectionIds',
  'actions',
  'entities',
  'columns',
  'limits',
  'overrideWhereRequired',
  'enabled',
] as const satisfies ReadonlyArray<keyof PolicyInput>;

/** The one patch allowed on a stored rule that does not validate: switching it off. */
function isDisableOnly(patch: unknown): boolean {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return false;
  const keys = Object.keys(patch);
  return keys.length === 1 && keys[0] === 'enabled' && (patch as PolicyPatch).enabled === false;
}

function denyAll(reasons: string[], version = ''): PolicyDecision {
  return {
    effect: 'DENY',
    reasons,
    matchedRuleIds: [],
    limits: { ...DEFAULT_LIMITS },
    rowLimitsFromRules: { maxReadRows: false, maxWriteRows: false },
    policyVersion: version,
  };
}

const notFound = () => new AppError('NOT_FOUND', 'Policy not found');

/** The single row -> rule mapping. Values are passed through untouched, so validation sees them. */
function toRule(row: PolicyRow): PolicyRule {
  return {
    id: row.id,
    name: row.name,
    effect: row.effect,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    environments: row.environments as Environment[],
    connectionIds: row.connectionIds,
    actions: row.actions,
    entities: row.entities,
    columns: row.columns,
    limits: row.limits as PolicyRule['limits'],
    overrideWhereRequired: row.overrideWhereRequired,
    enabled: row.enabled,
  };
}

function toRecord(row: PolicyRow): PolicyRecord {
  return { ...toRule(row), updatedAt: row.updatedAt.toISOString() };
}

/** The single rule -> row mapping (everything but the id and the timestamp). */
function toColumns(rule: PolicyRule) {
  return {
    name: rule.name,
    effect: rule.effect,
    subjectType: rule.subjectType,
    subjectId: rule.subjectId,
    environments: rule.environments,
    connectionIds: rule.connectionIds,
    actions: rule.actions,
    entities: rule.entities,
    columns: rule.columns,
    limits: rule.limits as Record<string, unknown>,
    overrideWhereRequired: rule.overrideWhereRequired,
    enabled: rule.enabled,
  };
}

function freezeRule(rule: PolicyRule): PolicyRule {
  for (const value of Object.values(rule)) {
    if (typeof value === 'object' && value !== null) Object.freeze(value);
  }
  return Object.freeze(rule);
}

function invalidInput(problems: string[]): AppError {
  return new AppError('VALIDATION_ERROR', `Invalid policy: ${problems.join('; ')}`, { problems });
}

/** Copies only the known own fields of a client payload (no prototype or extra keys). */
function pick(input: unknown): Partial<PolicyInput> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw invalidInput(['policy must be an object']);
  }
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = (input as Record<string, unknown>)[key];
      if (value !== undefined) out[key] = value;
    }
  }
  return out as Partial<PolicyInput>;
}

/** Validates a rule about to be saved; throws VALIDATION_ERROR listing every problem. */
function assertSavable(rule: PolicyRule): void {
  const problems = validatePolicyRule(rule);
  if (typeof rule.name !== 'string' || rule.name.trim() === '') {
    problems.push('name must not be empty');
  } else if (rule.name.length > MAX_NAME) {
    problems.push(`name must be at most ${MAX_NAME} characters`);
  }
  // A missing or non-string subjectId is already reported by validatePolicyRule.
  if (rule.subjectType !== 'everyone' && typeof rule.subjectId === 'string') {
    if (!UUID.test(rule.subjectId)) problems.push('subjectId must be a user or group id');
  }
  if (Array.isArray(rule.connectionIds)) {
    const bad = rule.connectionIds.filter((c) => typeof c !== 'string' || !UUID.test(c));
    if (bad.length > 0)
      problems.push(`connectionIds must be stored connection ids: ${bad.join(', ')}`);
  }
  if (problems.length > 0) throw invalidInput(problems);
}

/**
 * Persisted policy rules. Every save is validated with `validatePolicyRule`; the stored set is
 * validated again on each load, and an invalid enabled rule (only possible by writing to the table
 * directly) is reported in `current().invalid` and logged, while `evaluatePolicy` denies every
 * request. The rule set is cached until a write through this service or `invalidate()`.
 */
export class PolicyService {
  private cache: Promise<PolicySnapshot> | null = null;

  constructor(
    private readonly db: Database,
    private readonly logger: PolicyLogger,
  ) {}

  async list(): Promise<PolicyRecord[]> {
    const rows = await this.db
      .select()
      .from(policies)
      .orderBy(asc(policies.name), asc(policies.id));
    return rows.map(toRecord);
  }

  async create(input: PolicyInput): Promise<PolicyRecord> {
    const fields = pick(input);
    // The id is assigned by the database; a placeholder lets the full rule be validated.
    const rule = { ...fields, id: 'new' } as PolicyRule;
    if (rule.subjectType === 'everyone') rule.subjectId = null;
    assertSavable(rule);
    const [row] = await this.db.insert(policies).values(toColumns(rule)).returning();
    this.invalidate();
    return toRecord(row!);
  }

  /**
   * Merges `patch` into the stored rule and validates the result. The read, merge and write run
   * in one transaction with the row locked, so concurrent updates cannot lose each other's
   * changes. `{ enabled: false }` alone is accepted even on a rule that does not validate, so an
   * admin can always switch a corrupt rule off.
   */
  async update(id: string, patch: PolicyPatch): Promise<PolicyRecord> {
    if (!UUID.test(id)) throw notFound();
    const disableOnly = isDisableOnly(patch);
    const fields = pick(patch);
    try {
      return await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(policies)
          .where(eq(policies.id, id))
          .for('update');
        if (!existing) throw notFound();
        let values: Partial<ReturnType<typeof toColumns>>;
        if (disableOnly) {
          values = { enabled: false };
        } else {
          const rule = { ...toRule(existing), ...fields, id: existing.id } as PolicyRule;
          if (rule.subjectType === 'everyone') rule.subjectId = null;
          assertSavable(rule);
          values = toColumns(rule);
        }
        const [row] = await tx
          .update(policies)
          .set({ ...values, updatedAt: sql`now()` })
          .where(eq(policies.id, existing.id))
          .returning();
        if (!row) throw notFound();
        return toRecord(row);
      });
    } finally {
      this.invalidate();
    }
  }

  async delete(id: string): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    const deleted = await this.db
      .delete(policies)
      .where(eq(policies.id, id))
      .returning({ id: policies.id });
    this.invalidate();
    if (deleted.length === 0) throw notFound();
  }

  /** Re-reads and re-validates the stored rules now (startup, reload). */
  async load(): Promise<PolicySnapshot> {
    this.invalidate();
    return this.current();
  }

  /** The cached rule set, read on first use and after each invalidation. */
  current(): Promise<PolicySnapshot> {
    if (!this.cache) {
      const pending = this.read().catch((err: unknown) => {
        // Never cache a failure: the next call tries again (callers fail closed meanwhile).
        if (this.cache === pending) this.cache = null;
        throw err;
      });
      this.cache = pending;
    }
    return this.cache;
  }

  /**
   * The only entry point for policy-evaluated actions: `evaluatePolicy` over the current rule set.
   * Never throws. If the rules cannot be loaded, or any enabled stored rule is invalid, every
   * action is denied.
   */
  async evaluate(
    req: PolicyRequest,
    permissions: Set<Permission>,
    options: Omit<EvaluateOptions, 'policyVersion'> = {},
  ): Promise<PolicyDecision> {
    let snapshot: PolicySnapshot;
    try {
      snapshot = await this.current();
    } catch (err) {
      this.logSafe('error', { err }, 'Policies unavailable: denying every policy-evaluated action');
      return denyAll(['policies unavailable']);
    }
    try {
      if (snapshot.invalid.length > 0) {
        return denyAll(
          snapshot.invalid.map((entry) => `invalid policy rule ${entry}`),
          snapshot.version,
        );
      }
      return evaluatePolicy(req, snapshot.rules, permissions, {
        ...options,
        policyVersion: snapshot.version,
      });
    } catch (err) {
      this.logSafe('error', { err }, 'Policy evaluation failed');
      return denyAll(['policy evaluation failed'], snapshot.version);
    }
  }

  invalidate(): void {
    this.cache = null;
  }

  private logSafe(level: 'error' | 'warn', obj: object, msg: string): void {
    try {
      this.logger[level](obj, msg);
    } catch {
      // Logging must never turn a denial into a throw.
    }
  }

  private async read(): Promise<PolicySnapshot> {
    const rows = await this.db.select().from(policies).orderBy(asc(policies.id));
    const rules = rows.map((r) => freezeRule(toRule(r)));
    const invalid: string[] = [];
    const ignored: string[] = [];
    for (const rule of rules) {
      const problems = validatePolicyRule(rule);
      if (problems.length === 0) continue;
      const entry = `${rule.id} (${rule.name}): ${problems.join('; ')}`;
      if (rule.enabled === true) invalid.push(entry);
      else ignored.push(entry);
    }
    if (invalid.length > 0) {
      this.logSafe(
        'error',
        { invalidPolicies: invalid },
        'Invalid enabled policy rules: every policy-evaluated action is denied until they are fixed',
      );
    }
    if (ignored.length > 0) {
      this.logSafe('warn', { invalidPolicies: ignored }, 'Invalid disabled policy rules (ignored)');
    }
    return Object.freeze({
      rules,
      version: policyVersion(rules),
      invalid,
    }) as PolicySnapshot;
  }
}
