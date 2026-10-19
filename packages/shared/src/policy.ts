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
 *
 * Normalization and matching:
 * - Ids (`userId`, `groupIds`, `connectionId`, rule `subjectId` and `connectionIds`) are trimmed
 *   and lower-cased, then compared exactly. Environments and actions are exact catalog values.
 * - Entity names: each dot-separated segment is trimmed and stripped of `"…"` or `[…]` quoting,
 *   then upper-cased. A rule entity pattern matches when it matches the full dotted name OR its
 *   last segment, so `TGFPAR` hits `SANKHYA.TGFPAR`, `dbo.TGFPAR`, `"TGFPAR"` and `[TGFPAR]`.
 *   Callers pass resolved base table names, not views, aliases or synonyms.
 * - Patterns are case-insensitive globs where `*` is any run of characters (`TGF*` hits `TGFPAR`).
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
 *    ceilings that rules can only lower. Flags are OR-ed; `requirePreview` and
 *    `requireConfirmation` are always true.
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
}

export const DEFAULT_LIMITS: Readonly<EffectiveLimits> = Object.freeze({
  maxReadRows: 1000,
  maxWriteRows: 50,
  requireWhere: false,
  requirePreview: true,
  requireConfirmation: true,
  requireStrongConfirmation: false,
  requireApproval: false,
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
  policyVersion: string;
}

export interface EvaluateOptions {
  /** A version already computed with `policyVersion(policies)`, to skip rehashing per call. */
  policyVersion?: string;
  /**
   * Row-limit ceilings replacing the rule-7 defaults (from configuration). Each must be a
   * positive safe integer; an invalid value falls back to the rule-7 default.
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

interface Entity {
  full: string;
  last: string;
}
interface Column {
  entity: Entity;
  name: string;
}
interface ColumnPattern {
  table: string | null;
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
  entities: string[];
  columns: ColumnPattern[];
  rows: Partial<Record<RowLimit, number>>;
  flags: Partial<Record<FlagLimit, boolean>>;
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
      policyVersion: version,
    };
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
  const reasons: string[] = [];
  const matchedRuleIds: string[] = [];
  const deny = (...why: string[]): PolicyDecision => ({
    effect: 'DENY',
    reasons: [...reasons, ...why],
    matchedRuleIds,
    limits,
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
    const compiled = compileRule(raw);
    if (compiled) rules.push(compiled);
    else invalid.push(`invalid rule ${describeId(raw)}`);
  }
  if (invalid.length > 0) return deny(...invalid);

  const applicable = rules.filter((r) => matchesContext(r, req) && overlaps(r, req));
  const denies = applicable.filter((r) => r.effect === 'DENY');
  const allows = applicable.filter((r) => r.effect === 'ALLOW');
  matchedRuleIds.push(...applicable.map((r) => r.id));

  for (const key of ROW_LIMITS) {
    limits[key] = Math.min(limits[key], ...allows.map((r) => r.rows[key] ?? limits[key]));
  }
  for (const key of FLAG_LIMITS) {
    limits[key] = DEFAULT_LIMITS[key] || allows.some((r) => r.flags[key] === true);
  }
  limits.requirePreview = true;
  limits.requireConfirmation = true;

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

  return { effect: 'ALLOW', reasons, matchedRuleIds, limits, policyVersion: version };
}

function readOwn(obj: unknown, key: string): unknown {
  return typeof obj === 'object' && obj !== null && Object.hasOwn(obj, key)
    ? (obj as Record<string, unknown>)[key]
    : undefined;
}

function isPositiveSafeInteger(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
}

function resolveCeilings(defaults: unknown): Pick<EffectiveLimits, RowLimit> {
  const read = readOwn(defaults, 'maxReadRows');
  const write = readOwn(defaults, 'maxWriteRows');
  return {
    maxReadRows: isPositiveSafeInteger(read) ? read : DEFAULT_LIMITS.maxReadRows,
    maxWriteRows: isPositiveSafeInteger(write) ? write : DEFAULT_LIMITS.maxWriteRows,
  };
}

function describeId(r: object): string {
  const id = readOwn(r, 'id');
  return typeof id === 'string' && id !== '' ? id : '(no id)';
}

const normalizeId = (s: string): string => s.trim().toLowerCase();

function unquote(segment: string): string {
  const s = segment.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).trim();
  if (s.length >= 2 && s.startsWith('[') && s.endsWith(']')) return s.slice(1, -1).trim();
  return s;
}

function normalizeEntity(name: string): Entity {
  const segments = name.split('.').map((s) => unquote(s).toUpperCase());
  return { full: segments.join('.'), last: segments[segments.length - 1]! };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

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
  const ents = entities.map(normalizeEntity);
  if (ents.some((e) => e.last === '')) return 'entities';

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
      const t = normalizeEntity(table);
      // A column belongs to the entities it names: by full name, or by last segment when the
      // column's table is unqualified. Anything else cannot be attributed and fails closed.
      const owners = ents.filter(
        (e) =>
          e.full === t.full ||
          (!t.full.includes('.') && e.last === t.full) ||
          (!e.full.includes('.') && t.last === e.full),
      );
      if (owners.length === 0)
        return `column ${table}.${name} is not attributed to a request entity`;
      const n = unquote(name).toUpperCase();
      for (const entity of owners) cols.push({ entity, name: n });
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

/** Validates a rule from its own properties and compiles it, or returns null when invalid. */
function compileRule(r: object): CompiledRule | null {
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

  if (!isNonEmptyString(id) || typeof name !== 'string') return null;
  if (effect !== 'ALLOW' && effect !== 'DENY') return null;
  let subject = '';
  if (subjectType === 'user' || subjectType === 'group') {
    if (!isNonEmptyString(subjectId)) return null;
    subject = normalizeId(subjectId);
  } else if (subjectType !== 'everyone') {
    return null;
  }
  if (!isPatternList(environments) || !environments.every((e) => ENVIRONMENT_SET.has(e))) {
    return null;
  }
  // Ids are trimmed and lower-cased like the request's; patterns must be exact (no padding).
  if (!Array.isArray(connectionIds) || !connectionIds.every(isNonEmptyString)) return null;
  if (!isPatternList(actions) || actions.length === 0 || !actions.every(isValidAction)) {
    return null;
  }
  if (!isPatternList(entities) || !isPatternList(columns)) return null;
  if (typeof override !== 'boolean') return null;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return null;

  const rows: CompiledRule['rows'] = {};
  const flags: CompiledRule['flags'] = {};
  for (const key of Object.keys(limits)) {
    const value = readOwn(limits, key);
    if (value === undefined) continue;
    if ((ROW_LIMITS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return null;
      rows[key as RowLimit] = value;
    } else if ((FLAG_LIMITS as readonly string[]).includes(key)) {
      if (typeof value !== 'boolean') return null;
      flags[key as FlagLimit] = value;
    } else {
      return null;
    }
  }

  const columnPatterns: ColumnPattern[] = [];
  for (const c of columns) {
    const dot = c.lastIndexOf('.');
    const table = dot < 0 ? null : c.slice(0, dot);
    const col = unquote(dot < 0 ? c : c.slice(dot + 1)).toUpperCase();
    if (col === '' || table === '') return null;
    columnPatterns.push({ table, name: col });
  }

  return {
    id,
    name,
    effect,
    subjectType,
    subjectId: subject,
    environments,
    connectionIds: connectionIds.map(normalizeId),
    actions,
    entities,
    columns: columnPatterns,
    rows,
    flags,
    overrideWhereRequired: override,
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

function entityPatternHit(pattern: string, e: Entity): boolean {
  const p = normalizeEntity(pattern).full;
  return glob(p, e.full) || glob(p, e.last);
}

function entityMatches(r: CompiledRule, e: Entity): boolean {
  return r.entities.length === 0 || r.entities.some((p) => entityPatternHit(p, e));
}

function columnHit(p: ColumnPattern, col: Column, wildcardHits: boolean): boolean {
  if (p.table !== null && !entityPatternHit(p.table, col.entity)) return false;
  if (col.name === '*') return wildcardHits;
  return glob(p.name, col.name);
}

/** Whether a rule touches any part of the request (used by DENY and for limits). */
function overlaps(r: CompiledRule, req: NormalizedRequest): boolean {
  if (r.columns.length === 0) {
    return r.entities.length === 0 || req.entities.some((e) => entityMatches(r, e));
  }
  return req.columns.some(
    (c) => entityMatches(r, c.entity) && r.columns.some((p) => columnHit(p, c, true)),
  );
}

/** Whether an ALLOW rule fully grants the action on one entity (used for writes). */
function covers(r: CompiledRule, entity: Entity, req: NormalizedRequest): boolean {
  if (!entityMatches(r, entity)) return false;
  if (r.columns.length === 0) return true;
  const cols = req.columns.filter((c) => c.entity === entity);
  return cols.length > 0 && cols.every((c) => r.columns.some((p) => columnHit(p, c, false)));
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

/** JSON with object keys sorted, so equal rules hash equally whatever their key order. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
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
  const sorted = rules.map((r) => canonicalJson(r)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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
