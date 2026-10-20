/**
 * Pure policy evaluator. It runs after RBAC: a permission says what a user may attempt, a policy
 * says where, on what and under which limits. It has no I/O and no Node dependency, so the web
 * app can import it too.
 *
 * Security invariants:
 * - DENY wins over any ALLOW.
 * - There is no bypass: an administrator is evaluated like anyone else, by permission and rules.
 * - Anything unknown is denied (fail closed): an unknown action or environment, a malformed
 *   request, a malformed enabled rule, or any error while evaluating returns DENY, never throws.
 * - Only own properties of rules and limits are read, so prototype pollution cannot inject them.
 * - Scope: only callers of `evaluatePolicy` are policy-evaluated. `ADMIN.*` and `AUDIT.READ`
 *   checks are RBAC-only and never routed here, so an invalid rule (which denies everything here)
 *   cannot lock administrators out of fixing it. Use `validatePolicyRule` on save and at startup.
 *
 * Normalization and matching:
 * - Ids (`userId`, `groupIds`, `connectionId`, rule `subjectId` and `connectionIds`) are trimmed
 *   and lower-cased, then compared exactly. Environments and actions are exact catalog values.
 * - Entity names are `TABLE` or `SCHEMA.TABLE`: each part is trimmed, stripped of `"…"` or
 *   `[…]` quoting and upper-cased. A request entity with more than two parts (another database
 *   or a linked server), an empty part, unbalanced quoting, or a part that is not, once unquoted,
 *   a plain identifier (`[A-Za-z0-9_$#@]+`: no dot, quote, backtick, `*` or space) is malformed
 *   (DENY). Rule entity patterns follow the same shape (plus `*`), or the rule is invalid. Callers
 *   pass resolved base table names, not views, aliases or synonyms.
 * - Upper-casing makes quoted identifiers case-insensitive: ALLOW `TGFPAR` covers `"tgfpar"`,
 *   which Oracle treats as a different table. Accepted (low impact); callers on case-sensitive
 *   catalogs should reject such names before evaluating.
 * - ALLOW matching is strict and part-wise: an unqualified pattern matches the table part only
 *   (`TGFPAR` covers `TGFPAR` and `dbo.TGFPAR`); a qualified one matches schema and table part
 *   by part (`SANKHYA.TGF*` covers `sankhya.TGFPAR`, not `TGFPAR` or `dbo.TGFPAR`).
 * - DENY matching is broad (fail closed): anything ALLOW would match, plus the pattern against the
 *   full name, and a qualified pattern's table part against an unqualified entity, since the
 *   schema an unqualified name resolves to is unknown here. So DENY `X.TGFPAR` hits a plain
 *   `TGFPAR`, and DENY `SYS.*` hits every unqualified name; send schema-qualified names to
 *   avoid that over-match.
 * - Patterns are case-insensitive globs where `*` is any run of characters (`TGF*` hits `TGFPAR`).
 *   In ALLOW matching `*` never crosses a dot, since it is applied per part.
 * - A rule matches only when `enabled === true`. Disabled rules are ignored, even malformed ones.
 * - Subject: `user` matches `subjectId === userId`, `group` matches a `groupIds` entry,
 *   `everyone` matches anyone.
 * - `environments` and `connectionIds`: empty means all. `entities`: empty means all entities;
 *   a rule with entities never matches a request without entities.
 * - `actions` must be non-empty, and each entry an exact permission or a glob matching at least
 *   one permission (`DATA.*`, `*`). Anything else makes the rule invalid, which fails closed, so a
 *   DENY can never be silently inert through an empty list or a typo.
 * - `columns`: `TABLE.COLUMN` (the table part is an entity pattern) or a bare `COLUMN` that
 *   matches the column on any table. A rule with columns applies only to the request columns it
 *   names, on tables that also pass its `entities` filter.
 *
 * Request columns (caller contract):
 * - `columns` must list EVERY column the statement references: select list, WHERE, JOIN, GROUP
 *   BY, ORDER BY and subqueries, otherwise a column DENY can be inferred around through a
 *   predicate. Each column's `table` must name one of `entities`; a column that cannot be
 *   attributed to a request entity makes the request malformed (DENY).
 * - `columns: undefined` means unknown and is treated as `*` on every entity. `[]` means the
 *   statement references no column. A column named `*` (an unexpanded `SELECT *`) is hit by every
 *   column DENY on its table and is never covered by a column-scoped ALLOW.
 *
 * Decision:
 * 1. Missing permission: DENY ("permission missing").
 * 2. A DENY rule that matches and overlaps any requested entity or column: DENY.
 * 3. Writes (see `POLICY_ACTION_CLASS`) are default-deny: every requested entity must be covered
 *    by a matching ALLOW rule (one whose entities match it and, when the rule has columns, whose
 *    columns cover every requested column of that entity). `QUERY.SELECT`, `TEMP.*` and the
 *    other permission-only actions are allowed by permission alone unless denied.
 *    NOTE: every matching ALLOW is a grant. A rule meant only to cap limits (for example
 *    `actions: ['DATA.*']`, `limits: { maxWriteRows: 5 }`) also grants those writes to its subject
 *    on every entity it matches. Scope such rules carefully.
 * 4. Limits combine over the matching ALLOW rules (any overlap) to the most restrictive. Row
 *    limits are min(ceiling, every rule value): the rule-7 defaults (or `options.defaults`) are
 *    ceilings that rules can only lower. `options.defaults` is trusted operator configuration and
 *    may raise the ceilings, but never above `POLICY_HARD_MAX_LIMITS`. Flags are OR-ed; `requirePreview` and
 *    `requireConfirmation` are always true. `auditSnapshots` (default true) is AND-ed: any
 *    matching ALLOW rule that sets it false wins.
 * 5. In PRODUCTION a write forces `requireConfirmation` and `requireStrongConfirmation`.
 * 6. UPDATE/DELETE without WHERE: DENY, unless one matching ALLOW rule with
 *    `overrideWhereRequired` covers every requested entity on its own and no matching rule sets
 *    `limits.requireWhere`. The override forces `requireStrongConfirmation` and `requireApproval`.
 *    `limits.requireWhere` reports whether the statement needs a WHERE.
 * 7. Defaults: see `DEFAULT_LIMITS`.
 */
import { PERMISSIONS, type Permission } from './permissions';

export const ENVIRONMENTS = ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export type PolicyEffect = 'ALLOW' | 'DENY';
export type PolicySubjectType = 'user' | 'group' | 'everyone';

export interface EffectiveLimits {
  maxReadRows: number;
  maxWriteRows: number;
  requireWhere: boolean;
  requirePreview: boolean;
  requireConfirmation: boolean;
  requireStrongConfirmation: boolean;
  requireApproval: boolean;
  /** Whether the audit stores before/after row values of a write; false keeps counts and keys. */
  auditSnapshots: boolean;
}

export const DEFAULT_LIMITS: Readonly<EffectiveLimits> = Object.freeze({
  maxReadRows: 1000,
  maxWriteRows: 50,
  requireWhere: false,
  requirePreview: true,
  requireConfirmation: true,
  requireStrongConfirmation: false,
  requireApproval: false,
  auditSnapshots: true,
});

export interface PolicyRule {
  id: string;
  name: string;
  effect: PolicyEffect;
  subjectType: PolicySubjectType;
  /** Required for `user` and `group`; ignored for `everyone`. */
  subjectId: string | null;
  environments: Environment[];
  connectionIds: string[];
  actions: string[];
  entities: string[];
  columns: string[];
  limits: Partial<EffectiveLimits>;
  overrideWhereRequired: boolean;
  enabled: boolean;
}

export interface PolicyColumn {
  table: string;
  name: string;
}

export interface PolicyRequest {
  userId: string;
  groupIds: string[];
  action: Permission;
  environment: Environment;
  connectionId: string;
  entities: string[];
  /** Every referenced column; `undefined` means unknown and is treated as `*`. */
  columns?: PolicyColumn[];
  hasWhere: boolean;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reasons: string[];
  matchedRuleIds: string[];
  limits: EffectiveLimits;
  /**
   * Which row limits a matching ALLOW rule set (as opposed to the defaults or ceilings), so a
   * caller can apply a limit only when a rule asked for it.
   */
  rowLimitsFromRules: { maxReadRows: boolean; maxWriteRows: boolean };
  policyVersion: string;
}

export interface EvaluateOptions {
  /** A version already computed with `policyVersion(policies)`, to skip rehashing per call. */
  policyVersion?: string;
  /**
   * Row-limit ceilings replacing the rule-7 defaults (trusted operator configuration). Each must be
   * a positive safe integer and is clamped to `POLICY_HARD_MAX_LIMITS`; an invalid value falls
   * back to the rule-7 default. Rules can still only lower the result.
   */
  defaults?: Partial<Pick<EffectiveLimits, 'maxReadRows' | 'maxWriteRows'>>;
}

/**
 * Exhaustive classification: adding a permission is a compile error until it is classified here.
 * `write` actions need an explicit ALLOW rule; `permission-only` ones are allowed by permission
 * unless a DENY matches.
 */
export const POLICY_ACTION_CLASS: Readonly<Record<Permission, 'write' | 'permission-only'>> =
  Object.freeze({
    'QUERY.SELECT': 'permission-only',
    'TEMP.CREATE': 'permission-only',
    'TEMP.WRITE': 'permission-only',
    'TEMP.DROP': 'permission-only',
    'TEMP.MATERIALIZE': 'permission-only',
    'DATA.INSERT': 'write',
    'DATA.UPDATE': 'write',
    'DATA.DELETE': 'write',
    'DDL.CUSTOM.GENERATE': 'write',
    'SANKHYA.BUSINESS_ACTION.EXECUTE': 'write',
    'APPROVAL.DECIDE': 'permission-only',
    'AUDIT.READ': 'permission-only',
    'ADMIN.USERS': 'permission-only',
    'ADMIN.GROUPS': 'permission-only',
    'ADMIN.ROLES': 'permission-only',
    'ADMIN.POLICIES': 'permission-only',
    'ADMIN.CONNECTIONS': 'permission-only',
    'ADMIN.SECURITY': 'permission-only',
  });

/** Writes need an explicit ALLOW rule. An unknown action counts as a write (fail closed). */
export function isPolicyWriteAction(action: string): boolean {
  return !Object.hasOwn(POLICY_ACTION_CLASS, action)
    ? true
    : POLICY_ACTION_CLASS[action as Permission] !== 'permission-only';
}

const ROW_LIMITS = ['maxReadRows', 'maxWriteRows'] as const;
const FLAG_LIMITS = [
  'requireWhere',
  'requirePreview',
  'requireConfirmation',
  'requireStrongConfirmation',
  'requireApproval',
] as const;
type RowLimit = (typeof ROW_LIMITS)[number];
type FlagLimit = (typeof FLAG_LIMITS)[number];
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const ENVIRONMENT_SET: ReadonlySet<string> = new Set(ENVIRONMENTS);

/**
 * Hard maxima for `options.defaults`. Operator configuration is trusted to set the ceilings, but
 * never above these; rules can still only lower the result.
 */
export const POLICY_HARD_MAX_LIMITS: Readonly<Pick<EffectiveLimits, RowLimit>> = Object.freeze({
  maxReadRows: 100000,
  maxWriteRows: 1000,
});

/** A parsed, upper-cased name of one or two parts (`TABLE` or `SCHEMA.TABLE`). */
interface Entity {
  full: string;
  parts: string[];
  last: string;
}
interface Column {
  entity: Entity;
  name: string;
}
interface ColumnPattern {
  table: string[] | null;
  name: string;
}
interface CompiledRule {
  id: string;
  name: string;
  effect: PolicyEffect;
  subjectType: PolicySubjectType;
  subjectId: string;
  environments: string[];
  connectionIds: string[];
  actions: string[];
  entities: string[][];
  columns: ColumnPattern[];
  rows: Partial<Record<RowLimit, number>>;
  flags: Partial<Record<FlagLimit, boolean>>;
  auditSnapshots?: boolean;
  overrideWhereRequired: boolean;
}
interface NormalizedRequest {
  userId: string;
  groupIds: string[];
  action: Permission;
  environment: Environment;
  connectionId: string;
  entities: Entity[];
  columns: Column[];
  hasWhere: boolean;
}

export function evaluatePolicy(
  req: PolicyRequest,
  policies: PolicyRule[],
  permissions: Set<Permission>,
  options: EvaluateOptions = {},
): PolicyDecision {
  let version = '';
  try {
    const given = readOwn(options, 'policyVersion');
    version = typeof given === 'string' ? given : policyVersion(policies);
    return evaluate(req, policies, permissions, options, version);
  } catch {
    return {
      effect: 'DENY',
      reasons: ['policy evaluation failed'],
      matchedRuleIds: [],
      limits: { ...DEFAULT_LIMITS },
      rowLimitsFromRules: { maxReadRows: false, maxWriteRows: false },
      policyVersion: version,
    };
  }
}

/** The request context of a `DenyChecker`: everything but what is read. */
export type PolicyContext = Pick<
  PolicyRequest,
  'userId' | 'groupIds' | 'action' | 'environment' | 'connectionId'
>;

/**
 * The rule set compiled once for one permission-only action in one context, for callers that
 * evaluate many entity/column requests in a row (the schema catalog filter).
 */
export interface DenyChecker {
  /** How many enabled DENY rules match the context; 0 means only a malformed name is denied. */
  readonly denyRules: number;
  /**
   * Whether `evaluatePolicy` would DENY `{ ...context, entities, columns, hasWhere: false }`.
   * Never throws (an error counts as denied).
   */
  denied(entities: string[], columns: PolicyColumn[]): boolean;
}

/**
 * Compiles `policies` once for a permission-only action (see `POLICY_ACTION_CLASS`), where only
 * DENY rules decide the effect: a request is denied exactly when it is malformed or a DENY rule
 * that matches the context overlaps it, which is what `evaluatePolicy` decides. Returns null,
 * meaning deny everything, when `evaluatePolicy` would deny every request of the context: the
 * action is unknown, a write or not held, the environment or context is malformed, or any enabled
 * rule is invalid. Never throws.
 */
export function compileDenyChecker(
  context: PolicyContext,
  policies: PolicyRule[],
  permissions: Set<Permission>,
): DenyChecker | null {
  try {
    const action = readOwn(context, 'action');
    const environment = readOwn(context, 'environment');
    if (typeof action !== 'string' || !PERMISSION_SET.has(action)) return null;
    if (isPolicyWriteAction(action)) return null;
    if (typeof environment !== 'string' || !ENVIRONMENT_SET.has(environment)) return null;
    const base = {
      userId: readOwn(context, 'userId'),
      groupIds: readOwn(context, 'groupIds'),
      action,
      environment,
      connectionId: readOwn(context, 'connectionId'),
    } as PolicyContext;
    const ctx = normalizeRequest({ ...base, entities: [], columns: [], hasWhere: false });
    if (typeof ctx === 'string') return null;
    if (typeof permissions?.has !== 'function' || permissions.has(ctx.action) !== true) return null;
    if (!Array.isArray(policies)) return null;
    const denies: CompiledRule[] = [];
    for (const raw of policies) {
      if (typeof raw !== 'object' || raw === null) return null;
      if (readOwn(raw, 'enabled') !== true) continue;
      const { rule } = compileRule(raw);
      if (!rule) return null;
      if (rule.effect === 'DENY' && matchesContext(rule, ctx)) denies.push(rule);
    }
    return {
      denyRules: denies.length,
      denied(entities, columns) {
        try {
          const req = normalizeRequest({ ...base, entities, columns, hasWhere: false });
          if (typeof req === 'string') return true;
          return denies.some((r) => overlaps(r, req));
        } catch {
          return true;
        }
      },
    };
  } catch {
    return null;
  }
}

/**
 * Whether `name` is a plain identifier (`[A-Za-z0-9_$#@]+`). A request whose table and column
 * names are all plain is never malformed, so with no DENY rule it is allowed.
 */
export function isPlainPolicyName(name: string): boolean {
  return typeof name === 'string' && IDENTIFIER.test(name);
}

/**
 * The problems that make a rule invalid; empty when it is valid. `evaluatePolicy` denies every
 * request while any ENABLED rule is invalid, so callers should run this when a rule is saved
 * (reject it) and over the stored rules at startup (report them).
 */
export function validatePolicyRule(rule: unknown): string[] {
  try {
    return compileRule(rule).problems;
  } catch {
    return ['rule could not be read'];
  }
}

function evaluate(
  rawReq: PolicyRequest,
  policies: PolicyRule[],
  permissions: Set<Permission>,
  options: EvaluateOptions,
  version: string,
): PolicyDecision {
  const ceilings = resolveCeilings(readOwn(options, 'defaults'));
  const limits: EffectiveLimits = { ...DEFAULT_LIMITS, ...ceilings };
  const rowLimitsFromRules = { maxReadRows: false, maxWriteRows: false };
  const reasons: string[] = [];
  const matchedRuleIds: string[] = [];
  const deny = (...why: string[]): PolicyDecision => ({
    effect: 'DENY',
    reasons: [...reasons, ...why],
    matchedRuleIds,
    limits,
    rowLimitsFromRules,
    policyVersion: version,
  });

  const action = readOwn(rawReq, 'action');
  const environment = readOwn(rawReq, 'environment');
  if (typeof action !== 'string' || !PERMISSION_SET.has(action)) {
    return deny(`unknown action ${String(action)}`);
  }
  if (typeof environment !== 'string' || !ENVIRONMENT_SET.has(environment)) {
    return deny(`unknown environment ${String(environment)}`);
  }
  const normalized = normalizeRequest(rawReq);
  if (typeof normalized === 'string') return deny(`malformed request: ${normalized}`);
  const req = normalized;
  if (typeof permissions?.has !== 'function' || permissions.has(req.action) !== true) {
    return deny(`permission missing: ${req.action}`);
  }

  if (!Array.isArray(policies)) return deny('malformed policy list');
  const rules: CompiledRule[] = [];
  const invalid: string[] = [];
  for (const raw of policies) {
    if (typeof raw !== 'object' || raw === null) {
      invalid.push('invalid rule (not an object)');
      continue;
    }
    if (readOwn(raw, 'enabled') !== true) continue;
    const { rule, problems } = compileRule(raw);
    if (rule) rules.push(rule);
    else invalid.push(`invalid rule ${describeId(raw)}: ${problems.join('; ')}`);
  }
  if (invalid.length > 0) return deny(...invalid);

  const applicable = rules.filter((r) => matchesContext(r, req) && overlaps(r, req));
  const denies = applicable.filter((r) => r.effect === 'DENY');
  const allows = applicable.filter((r) => r.effect === 'ALLOW');
  matchedRuleIds.push(...applicable.map((r) => r.id));

  for (const key of ROW_LIMITS) {
    limits[key] = Math.min(limits[key], ...allows.map((r) => r.rows[key] ?? limits[key]));
    rowLimitsFromRules[key] = allows.some((r) => r.rows[key] !== undefined);
  }
  for (const key of FLAG_LIMITS) {
    limits[key] = DEFAULT_LIMITS[key] || allows.some((r) => r.flags[key] === true);
  }
  limits.requirePreview = true;
  limits.requireConfirmation = true;
  // The restrictive value of auditSnapshots is false: any matching ALLOW rule turning it off wins.
  limits.auditSnapshots = !allows.some((r) => r.auditSnapshots === false);

  if (denies.length > 0) {
    return deny(...denies.map((r) => `denied by rule ${r.id} (${r.name})`));
  }

  const write = isPolicyWriteAction(req.action);
  if (write) {
    if (req.entities.length === 0) return deny('write without a target entity');
    const uncovered = req.entities.filter((e) => !allows.some((r) => covers(r, e, req)));
    if (uncovered.length > 0) {
      return deny(`no ALLOW rule for ${req.action} on ${uncovered.map((e) => e.full).join(', ')}`);
    }
    reasons.push(`allowed by rule(s) ${allows.map((r) => r.id).join(', ')}`);
  } else {
    reasons.push(`allowed by permission ${req.action}`);
  }

  if (req.action === 'DATA.UPDATE' || req.action === 'DATA.DELETE') {
    const forcedWhere = allows.some((r) => r.flags.requireWhere === true);
    const override = forcedWhere
      ? undefined
      : allows.find((r) => r.overrideWhereRequired && req.entities.every((e) => covers(r, e, req)));
    if (override) {
      limits.requireWhere = false;
      if (!req.hasWhere) {
        limits.requireStrongConfirmation = true;
        limits.requireApproval = true;
        reasons.push(`WHERE requirement overridden by rule ${override.id}`);
      }
    } else {
      limits.requireWhere = true;
      if (!req.hasWhere) return deny(`${req.action} without WHERE is not allowed`);
    }
  }

  if (write && req.environment === 'PRODUCTION') {
    limits.requireConfirmation = true;
    limits.requireStrongConfirmation = true;
  }

  return {
    effect: 'ALLOW',
    reasons,
    matchedRuleIds,
    limits,
    rowLimitsFromRules,
    policyVersion: version,
  };
}

function readOwn(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null && Object.hasOwn(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

/** Configured ceilings: positive safe integers clamped to the hard maxima, else rule 7. */
function resolveCeilings(defaults: unknown): Pick<EffectiveLimits, RowLimit> {
  const out = { ...POLICY_HARD_MAX_LIMITS };
  for (const key of ROW_LIMITS) {
    const v = readOwn(defaults, key);
    out[key] = isPositiveSafeInteger(v)
      ? Math.min(v, POLICY_HARD_MAX_LIMITS[key])
      : DEFAULT_LIMITS[key];
  }
  return out;
}

function describeId(r: object): string {
  const id = readOwn(r, 'id');
  return typeof id === 'string' && id !== '' ? id : '(no id)';
}

const normalizeId = (s: string): string => s.trim().toLowerCase();

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Splits a dotted name into upper-cased parts, honouring `"…"` and `[…]` quoting (so a quoted
 * part may not hide a dot). Returns null for an empty part, unbalanced quoting or stray quote
 * characters.
 */
function parseName(name: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  for (;;) {
    while (name[i] === ' ') i++;
    let part: string;
    const open = name[i];
    if (open === '"' || open === '[') {
      const close = open === '"' ? '"' : ']';
      const end = name.indexOf(close, i + 1);
      if (end < 0) return null;
      part = name.slice(i + 1, end).trim();
      i = end + 1;
      while (name[i] === ' ') i++;
    } else {
      const dot = name.indexOf('.', i);
      const end = dot < 0 ? name.length : dot;
      part = name.slice(i, end).trim();
      i = end;
    }
    if (part === '' || /["[\].]/.test(part)) return null;
    parts.push(part.toUpperCase());
    if (i >= name.length) return parts;
    if (name[i] !== '.') return null;
    i++;
  }
}

/** A request entity name part, after unquoting. */
const IDENTIFIER = /^[A-Za-z0-9_$#@]+$/;

function toEntity(parts: string[]): Entity {
  return { full: parts.join('.'), parts, last: parts[parts.length - 1]! };
}

const sameParts = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((p, i) => p === b[i]);

/** Validates and normalizes a request; returns the reason when it is malformed. */
function normalizeRequest(req: PolicyRequest): NormalizedRequest | string {
  const userId = readOwn(req, 'userId');
  const connectionId = readOwn(req, 'connectionId');
  const groupIds = readOwn(req, 'groupIds');
  const entities = readOwn(req, 'entities');
  const columns = readOwn(req, 'columns');
  const hasWhere = readOwn(req, 'hasWhere');
  if (!isNonEmptyString(userId)) return 'userId';
  if (!isNonEmptyString(connectionId)) return 'connectionId';
  if (!Array.isArray(groupIds) || !groupIds.every(isNonEmptyString)) return 'groupIds';
  if (!Array.isArray(entities) || !entities.every(isNonEmptyString)) return 'entities';
  if (typeof hasWhere !== 'boolean') return 'hasWhere';

  // At most SCHEMA.TABLE: three- and four-part names reach other databases or linked servers.
  const ents: Entity[] = [];
  for (const name of entities) {
    const parts = parseName(name);
    if (!parts || parts.length > 2 || !parts.every((p) => IDENTIFIER.test(p))) {
      return `entity ${name}`;
    }
    const entity = toEntity(parts);
    if (!ents.some((e) => e.full === entity.full)) ents.push(entity);
  }

  let cols: Column[];
  if (columns === undefined) {
    cols = ents.map((entity) => ({ entity, name: '*' }));
  } else {
    if (!Array.isArray(columns)) return 'columns';
    cols = [];
    for (const c of columns as unknown[]) {
      const table = readOwn(c, 'table');
      const name = readOwn(c, 'name');
      if (!isNonEmptyString(table) || !isNonEmptyString(name)) return 'columns';
      const t = parseName(table);
      const n = parseName(name);
      if (!t || t.length > 2 || !n || n.length !== 1) return `column ${table}.${name}`;
      // A column belongs to the entities it names: same parts, or one side unqualified with the
      // same table. Anything else cannot be attributed and fails closed.
      const owners = ents.filter(
        (e) =>
          sameParts(e.parts, t) ||
          (t.length === 1 && e.last === t[0]) ||
          (e.parts.length === 1 && t[t.length - 1] === e.last),
      );
      if (owners.length === 0) {
        return `column ${table}.${name} is not attributed to a request entity`;
      }
      for (const entity of owners) cols.push({ entity, name: n[0]! });
    }
  }
  return {
    userId: normalizeId(userId),
    groupIds: groupIds.map(normalizeId),
    action: readOwn(req, 'action') as Permission,
    environment: readOwn(req, 'environment') as Environment,
    connectionId: normalizeId(connectionId),
    entities: ents,
    columns: cols,
    hasWhere,
  };
}

function isPatternList(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s !== '' && s === s.trim());
}

function isValidAction(pattern: string): boolean {
  return PERMISSIONS.some((p) => glob(pattern, p));
}

/** Validates a rule from its own properties and compiles it; `rule` is null when invalid. */
function compileRule(r: unknown): { rule: CompiledRule | null; problems: string[] } {
  const problems: string[] = [];
  const fail = () => ({ rule: null, problems });
  if (typeof r !== 'object' || r === null || Array.isArray(r)) {
    problems.push('not an object');
    return fail();
  }
  const id = readOwn(r, 'id');
  const name = readOwn(r, 'name');
  const effect = readOwn(r, 'effect');
  const subjectType = readOwn(r, 'subjectType');
  const subjectId = readOwn(r, 'subjectId');
  const environments = readOwn(r, 'environments');
  const connectionIds = readOwn(r, 'connectionIds');
  const actions = readOwn(r, 'actions');
  const entities = readOwn(r, 'entities');
  const columns = readOwn(r, 'columns');
  const limits = readOwn(r, 'limits');
  const override = readOwn(r, 'overrideWhereRequired');
  const enabled = readOwn(r, 'enabled');

  if (!isNonEmptyString(id)) problems.push('id must be a non-empty string');
  if (typeof name !== 'string') problems.push('name must be a string');
  if (effect !== 'ALLOW' && effect !== 'DENY') problems.push('effect must be ALLOW or DENY');
  if (subjectType === 'user' || subjectType === 'group') {
    if (!isNonEmptyString(subjectId)) problems.push(`subjectId is required for ${subjectType}`);
  } else if (subjectType !== 'everyone') {
    problems.push('subjectType must be user, group or everyone');
  }
  if (!isPatternList(environments) || !environments.every((e) => ENVIRONMENT_SET.has(e))) {
    problems.push(`environments must list only ${ENVIRONMENTS.join(', ')}`);
  }
  // Ids are trimmed and lower-cased like the request's.
  if (!Array.isArray(connectionIds) || !connectionIds.every(isNonEmptyString)) {
    problems.push('connectionIds must be non-empty strings');
  }
  if (!isPatternList(actions) || actions.length === 0) {
    problems.push('actions must be a non-empty list without padding');
  } else {
    const unknown = actions.filter((a) => !isValidAction(a));
    if (unknown.length > 0) problems.push(`unknown actions: ${unknown.join(', ')}`);
  }
  const entityPatterns: string[][] = [];
  if (!isPatternList(entities)) {
    problems.push('entities must be patterns without padding');
  } else {
    for (const e of entities) {
      const parts = parseName(e);
      if (!parts || parts.length > 2) problems.push(`invalid entity pattern ${e}`);
      else entityPatterns.push(parts);
    }
  }
  const columnPatterns: ColumnPattern[] = [];
  if (!isPatternList(columns)) {
    problems.push('columns must be patterns without padding');
  } else {
    for (const c of columns) {
      const parts = parseName(c);
      if (!parts || parts.length > 3) problems.push(`invalid column pattern ${c}`);
      else {
        columnPatterns.push({
          table: parts.length === 1 ? null : parts.slice(0, -1),
          name: parts[parts.length - 1]!,
        });
      }
    }
  }
  if (typeof override !== 'boolean') problems.push('overrideWhereRequired must be a boolean');
  if (typeof enabled !== 'boolean') problems.push('enabled must be a boolean');

  const rows: CompiledRule['rows'] = {};
  const flags: CompiledRule['flags'] = {};
  let auditSnapshots: boolean | undefined;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    problems.push('limits must be an object');
  } else {
    for (const key of Object.keys(limits)) {
      const value = readOwn(limits, key);
      if (value === undefined) continue;
      if ((ROW_LIMITS as readonly string[]).includes(key)) {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          problems.push(`${key} must be a non-negative integer`);
        } else rows[key as RowLimit] = value;
      } else if ((FLAG_LIMITS as readonly string[]).includes(key)) {
        if (typeof value !== 'boolean') problems.push(`${key} must be a boolean`);
        else flags[key as FlagLimit] = value;
      } else if (key === 'auditSnapshots') {
        if (typeof value !== 'boolean') problems.push(`${key} must be a boolean`);
        else auditSnapshots = value;
      } else {
        problems.push(`unknown limit ${key}`);
      }
    }
  }

  if (problems.length > 0) return fail();
  return {
    problems,
    rule: {
      id: id as string,
      name: name as string,
      effect: effect as PolicyEffect,
      subjectType: subjectType as PolicySubjectType,
      subjectId: subjectType === 'everyone' ? '' : normalizeId(subjectId as string),
      environments: environments as string[],
      connectionIds: (connectionIds as string[]).map(normalizeId),
      actions: actions as string[],
      entities: entityPatterns,
      columns: columnPatterns,
      rows,
      flags,
      ...(auditSnapshots !== undefined ? { auditSnapshots } : {}),
      overrideWhereRequired: override as boolean,
    },
  };
}

/** Subject, environment, connection and action. */
function matchesContext(r: CompiledRule, req: NormalizedRequest): boolean {
  const subject =
    r.subjectType === 'everyone' ||
    (r.subjectType === 'user' && r.subjectId === req.userId) ||
    (r.subjectType === 'group' && req.groupIds.includes(r.subjectId));
  if (!subject) return false;
  if (r.environments.length > 0 && !r.environments.includes(req.environment)) return false;
  if (r.connectionIds.length > 0 && !r.connectionIds.includes(req.connectionId)) return false;
  return r.actions.some((a) => glob(a, req.action));
}

/**
 * ALLOW (strict, part-wise): an unqualified pattern matches the table part only; a qualified one
 * matches schema and table part by part. `*` never crosses a dot.
 */
function allowHit(p: string[], e: Entity): boolean {
  if (p.length === 1) return glob(p[0]!, e.last);
  return e.parts.length === 2 && glob(p[0]!, e.parts[0]!) && glob(p[1]!, e.last);
}

/**
 * DENY (broad, fails closed): anything ALLOW would match, plus the pattern against the full name
 * (`*` may cross the dot), and a qualified pattern's table part against an unqualified entity.
 */
function denyHit(p: string[], e: Entity): boolean {
  const full = p.join('.');
  return (
    allowHit(p, e) ||
    glob(full, e.full) ||
    glob(full, e.last) ||
    (e.parts.length === 1 && glob(p[p.length - 1]!, e.last))
  );
}

type Hit = (p: string[], e: Entity) => boolean;

function hitFor(r: CompiledRule): Hit {
  return r.effect === 'DENY' ? denyHit : allowHit;
}

function entityMatches(r: CompiledRule, e: Entity, hit: Hit): boolean {
  return r.entities.length === 0 || r.entities.some((p) => hit(p, e));
}

function columnHit(p: ColumnPattern, col: Column, hit: Hit, wildcardHits: boolean): boolean {
  if (p.table !== null && !hit(p.table, col.entity)) return false;
  if (col.name === '*') return wildcardHits;
  return glob(p.name, col.name);
}

/** Whether a rule touches any part of the request (DENY, and ALLOW limits). */
function overlaps(r: CompiledRule, req: NormalizedRequest): boolean {
  const hit = hitFor(r);
  if (r.columns.length === 0) {
    return r.entities.length === 0 || req.entities.some((e) => entityMatches(r, e, hit));
  }
  return req.columns.some(
    (c) => entityMatches(r, c.entity, hit) && r.columns.some((p) => columnHit(p, c, hit, true)),
  );
}

/** Whether an ALLOW rule fully grants the action on one entity (used for writes). */
function covers(r: CompiledRule, entity: Entity, req: NormalizedRequest): boolean {
  if (!entityMatches(r, entity, allowHit)) return false;
  if (r.columns.length === 0) return true;
  const cols = req.columns.filter((c) => c.entity === entity);
  return (
    cols.length > 0 && cols.every((c) => r.columns.some((p) => columnHit(p, c, allowHit, false)))
  );
}

/** Case-insensitive glob where `*` matches any run of characters, including none. */
function glob(pattern: string, value: string): boolean {
  const p = pattern.toUpperCase();
  const v = value.toUpperCase();
  const parts = p.split('*');
  if (parts.length === 1) return p === v;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (v.length < first.length + last.length || !v.startsWith(first) || !v.endsWith(last)) {
    return false;
  }
  let at = first.length;
  const end = v.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = v.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
}

/**
 * Deterministic JSON: object keys sorted at every depth, undefined object values dropped, arrays
 * kept in order (undefined items written as null). Equal values hash equally whatever their key
 * order. Feed it plain JSON data: class instances (Date, Map...) are not special-cased.
 */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJSON(v ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJSON(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Version of a rule set: sha256 of the canonical JSON (keys sorted) of every rule, with the rules
 * sorted by that canonical JSON, so neither rule order nor key order matters and duplicate ids are
 * harmless. It covers every field, disabled rules included, so any change to any rule changes it.
 */
export function policyVersion(rules: readonly PolicyRule[]): string {
  const sorted = rules.map((r) => canonicalJSON(r)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256HexUtf8(`[${sorted.join(',')}]`);
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate, as TextEncoder does
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) {
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    } else {
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      );
    }
  }
  return out;
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. Pure, for browser and Node alike. */
export function sha256HexUtf8(text: string): string {
  const bytes = utf8(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0]) {
    bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  }

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (bytes[j]! << 24) | (bytes[j + 1]! << 16) | (bytes[j + 2]! << 8) | bytes[j + 3]!;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = w[i - 16]! + s0 + w[i - 7]! + s1;
    }
    const v = Array.from(h);
    for (let i = 0; i < 64; i++) {
      const [a, b, c, d, e, f, g, hh] = v as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      v.splice(0, 8, (t1 + s0 + maj) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g);
    }
    for (let i = 0; i < 8; i++) h[i] = h[i]! + v[i]!;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
