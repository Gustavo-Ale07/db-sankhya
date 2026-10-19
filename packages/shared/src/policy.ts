/**
 * Pure policy evaluator. It runs after RBAC: a permission says what a user may attempt, a policy
 * says where, on what and under which limits. It has no I/O and no Node dependency, so the web
 * app can import it too.
 *
 * Security invariants:
 * - DENY wins over any ALLOW.
 * - There is no bypass: an administrator is evaluated like anyone else, by permission and rules.
 * - Anything unknown is denied: an unknown action or environment, or an enabled rule that is
 *   malformed, denies the request (fail closed).
 *
 * Matching (all comparisons are case-insensitive):
 * - A rule matches only when `enabled === true`. Disabled rules are ignored, even malformed ones.
 * - Subject: `user` matches `subjectId === userId`, `group` matches a `groupIds` entry,
 *   `everyone` matches anyone.
 * - `environments` and `connectionIds`: empty means all.
 * - `actions`: permission names or globs (`DATA.*`, `*`). Empty matches no action, so a rule
 *   never grants every action by omission.
 * - `entities`: globs where `*` is any run of characters (`TGF*` matches `TGFPAR`). Empty means
 *   all entities. A rule with entities never matches a request without entities.
 * - `columns`: `TABLE.COLUMN` (the table part may be a glob) or a bare `COLUMN` that matches the
 *   column on any table. A rule with columns applies only to the request columns it names, and
 *   only on tables that also pass its `entities` filter. A request column named `*` (an
 *   unexpanded `SELECT *`) is hit by every column DENY on its table, and is never covered by a
 *   column-scoped ALLOW. Callers must list the columns a statement reads or writes; a request with
 *   no columns is not hit by column-scoped rules.
 *
 * Decision:
 * 1. Missing permission: DENY ("permission missing").
 * 2. A DENY rule that matches and overlaps any requested entity or column: DENY.
 * 3. Writes (`DATA.*`, `DDL.*`, `SANKHYA.*`) are default-deny: every requested entity must be
 *    covered by a matching ALLOW rule (one whose entities match it and, when the rule has columns,
 *    whose columns cover every requested column of that entity). `QUERY.SELECT` and `TEMP.*`
 *    are allowed by permission alone unless denied.
 * 4. Limits combine over the matching ALLOW rules (any overlap) to the most restrictive: the
 *    minimum row limit, OR of every `require*` flag. A row limit no rule sets keeps its default;
 *    flags are OR-ed with the defaults, so a rule can tighten but never relax a default flag.
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

export interface PolicyRequest {
  userId: string;
  groupIds: string[];
  action: Permission;
  environment: Environment;
  connectionId: string;
  entities: string[];
  columns: Array<{ table: string; name: string }>;
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
}

const ROW_LIMITS = ['maxReadRows', 'maxWriteRows'] as const;
const FLAG_LIMITS = [
  'requireWhere',
  'requirePreview',
  'requireConfirmation',
  'requireStrongConfirmation',
  'requireApproval',
] as const;
const LIMIT_KEYS: ReadonlySet<string> = new Set<string>([...ROW_LIMITS, ...FLAG_LIMITS]);
const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);
const ENVIRONMENT_SET: ReadonlySet<string> = new Set(ENVIRONMENTS);

/** Writes need an explicit ALLOW rule; everything else is allowed by permission alone. */
export function isPolicyWriteAction(action: string): boolean {
  return action.startsWith('DATA.') || action.startsWith('DDL.') || action.startsWith('SANKHYA.');
}

export function evaluatePolicy(
  req: PolicyRequest,
  policies: PolicyRule[],
  permissions: Set<Permission>,
  options: EvaluateOptions = {},
): PolicyDecision {
  const version = options.policyVersion ?? policyVersion(policies);
  const limits: EffectiveLimits = { ...DEFAULT_LIMITS };
  const reasons: string[] = [];
  const matchedRuleIds: string[] = [];
  const deny = (...why: string[]): PolicyDecision => ({
    effect: 'DENY',
    reasons: [...reasons, ...why],
    matchedRuleIds,
    limits,
    policyVersion: version,
  });

  if (!PERMISSION_SET.has(req.action)) return deny(`unknown action ${String(req.action)}`);
  if (!ENVIRONMENT_SET.has(req.environment)) {
    return deny(`unknown environment ${String(req.environment)}`);
  }
  if (!permissions.has(req.action)) return deny(`permission missing: ${req.action}`);

  const enabled = policies.filter((r) => r.enabled === true);
  const invalid = enabled.filter((r) => !isValidRule(r));
  if (invalid.length > 0) {
    return deny(...invalid.map((r) => `invalid rule ${describeId(r)}`));
  }

  const applicable = enabled.filter((r) => matchesContext(r, req) && overlaps(r, req));
  const denies = applicable.filter((r) => r.effect === 'DENY');
  const allows = applicable.filter((r) => r.effect === 'ALLOW');
  matchedRuleIds.push(...applicable.map((r) => r.id));

  // A row limit no matching rule sets keeps its default; otherwise the smallest one wins.
  for (const key of ROW_LIMITS) {
    const set = allows.map((r) => r.limits[key]).filter((v): v is number => v !== undefined);
    limits[key] = set.length > 0 ? Math.min(...set) : DEFAULT_LIMITS[key];
  }
  for (const key of FLAG_LIMITS) {
    limits[key] = DEFAULT_LIMITS[key] || allows.some((r) => r.limits[key] === true);
  }

  if (denies.length > 0) {
    return deny(...denies.map((r) => `denied by rule ${r.id} (${r.name})`));
  }

  const write = isPolicyWriteAction(req.action);
  if (write) {
    if (req.entities.length === 0) return deny('write without a target entity');
    const uncovered = req.entities.filter((e) => !allows.some((r) => covers(r, e, req)));
    if (uncovered.length > 0) {
      return deny(`no ALLOW rule for ${req.action} on ${uncovered.join(', ')}`);
    }
    reasons.push(`allowed by rule(s) ${allows.map((r) => r.id).join(', ')}`);
  } else {
    reasons.push(`allowed by permission ${req.action}`);
  }

  if (req.action === 'DATA.UPDATE' || req.action === 'DATA.DELETE') {
    const forcedWhere = allows.some((r) => r.limits.requireWhere === true);
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

function describeId(r: PolicyRule): string {
  return typeof r?.id === 'string' && r.id !== '' ? r.id : '(no id)';
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim() !== '');
}

function isValidRule(r: PolicyRule): boolean {
  if (typeof r !== 'object' || r === null) return false;
  if (typeof r.id !== 'string' || r.id === '' || typeof r.name !== 'string') return false;
  if (r.effect !== 'ALLOW' && r.effect !== 'DENY') return false;
  if (r.subjectType === 'user' || r.subjectType === 'group') {
    if (typeof r.subjectId !== 'string' || r.subjectId === '') return false;
  } else if (r.subjectType !== 'everyone') {
    return false;
  }
  if (!isStringArray(r.environments) || !r.environments.every((e) => ENVIRONMENT_SET.has(e))) {
    return false;
  }
  if (!isStringArray(r.connectionIds) || !isStringArray(r.actions)) return false;
  if (!isStringArray(r.entities) || !isStringArray(r.columns)) return false;
  if (typeof r.overrideWhereRequired !== 'boolean') return false;
  if (typeof r.limits !== 'object' || r.limits === null || Array.isArray(r.limits)) return false;
  for (const [key, value] of Object.entries(r.limits)) {
    if (!LIMIT_KEYS.has(key)) return false;
    if (value === undefined) continue;
    if ((ROW_LIMITS as readonly string[]).includes(key)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
    } else if (typeof value !== 'boolean') {
      return false;
    }
  }
  return true;
}

/** Subject, environment, connection and action. */
function matchesContext(r: PolicyRule, req: PolicyRequest): boolean {
  const subject =
    r.subjectType === 'everyone' ||
    (r.subjectType === 'user' && r.subjectId === req.userId) ||
    (r.subjectType === 'group' && req.groupIds.includes(r.subjectId ?? ''));
  if (!subject) return false;
  if (r.environments.length > 0 && !r.environments.includes(req.environment)) return false;
  if (r.connectionIds.length > 0 && !r.connectionIds.includes(req.connectionId)) return false;
  return r.actions.some((a) => glob(a, req.action));
}

function entityMatches(r: PolicyRule, entity: string): boolean {
  return r.entities.length === 0 || r.entities.some((p) => glob(p, entity));
}

/** Splits `TABLE.COLUMN` at the last dot; a bare `COLUMN` has no table part. */
function splitColumn(pattern: string): { table: string | null; name: string } {
  const dot = pattern.lastIndexOf('.');
  return dot < 0
    ? { table: null, name: pattern }
    : { table: pattern.slice(0, dot), name: pattern.slice(dot + 1) };
}

function columnHit(
  pattern: string,
  col: { table: string; name: string },
  wildcardHits: boolean,
): boolean {
  const p = splitColumn(pattern);
  if (p.table !== null && !glob(p.table, col.table)) return false;
  if (col.name === '*') return wildcardHits;
  return glob(p.name, col.name);
}

/** Whether a rule touches any part of the request (used by DENY and for limits). */
function overlaps(r: PolicyRule, req: PolicyRequest): boolean {
  if (r.columns.length === 0) {
    return r.entities.length === 0 || req.entities.some((e) => entityMatches(r, e));
  }
  return req.columns.some(
    (c) => entityMatches(r, c.table) && r.columns.some((p) => columnHit(p, c, true)),
  );
}

/** Whether an ALLOW rule fully grants the action on one entity (used for writes). */
function covers(r: PolicyRule, entity: string, req: PolicyRequest): boolean {
  if (!entityMatches(r, entity)) return false;
  if (r.columns.length === 0) return true;
  const cols = req.columns.filter((c) => c.table.toUpperCase() === entity.toUpperCase());
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
 * Version of a rule set: sha256 of the canonical JSON of the rules sorted by id. It covers every
 * field, disabled rules included, so any change to any rule changes it.
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
