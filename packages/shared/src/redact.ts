export const REDACTED = '***REDACTED***';

/**
 * Key names (normalized: lowercase, no separators) whose values must never be
 * emitted to logs, audit records or HTTP responses.
 */
const SENSITIVE_EXACT = new Set([
  'appkey',
  'appsecret',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'password',
  'passwd',
  'senha',
  'passwordhash',
  'newpassword',
  'currentpassword',
  'token',
  'apikey',
  'xapikey',
  'secret',
  'session',
  'sessionsecret',
  'sessionid',
  'sid',
  // Sankhya gateway (OAuth2 client credentials + X-Token) and legacy session names.
  'clientsecret',
  'xtoken',
  'accesstoken',
  'refreshtoken',
  'bearer',
  'jsessionid',
  'mgesession',
]);

const SENSITIVE_SUFFIXES = ['token', 'apikey', 'secret', 'password', 'passwd', 'senha'];

const MIN_SECRET_VALUE_LENGTH = 6;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function isSensitiveKey(key: string): boolean {
  const k = normalizeKey(key);
  if (SENSITIVE_EXACT.has(k)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => k.endsWith(suffix));
}

type StringScrubber = (s: string) => string;

// `Bearer <credential>` in free text (error messages, upstream bodies). A plain lowercase word
// after "bearer" is prose, not a credential, and is kept.
const BEARER_PATTERN = /\b(bearer)\s+([A-Za-z0-9._~+/-]+=*)/gi;
// Compact JWS/JWT: three base64url segments, the first starting with `{"` encoded as `eyJ`.
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Scrubs credential-shaped substrings that no key name or configured value would catch. */
function scrubPatterns(s: string): string {
  return s
    .replace(BEARER_PATTERN, (match, word: string, credential: string) =>
      /^[a-z]+$/.test(credential) ? match : `${word} ${REDACTED}`,
    )
    .replace(JWT_PATTERN, REDACTED);
}

function walk(value: unknown, scrub: StringScrubber, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((item) => walk(item, scrub, seen));
  if (value instanceof Error) {
    // Own enumerable props miss message/stack; keep them (scrubbed).
    const err: Record<string, unknown> = { name: value.name, message: scrub(value.message) };
    if (value.stack) err.stack = scrub(value.stack);
    for (const [key, child] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      err[key] = isSensitiveKey(key) ? REDACTED : walk(child, scrub, seen);
    }
    return err;
  }

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    out[key] = isSensitiveKey(key) ? REDACTED : walk(child, scrub, seen);
  }
  return out;
}

/**
 * Deep-copies `value`, replacing values of sensitive keys and bearer tokens or JWTs inside
 * strings. Never mutates input.
 */
export function redact<T>(value: T): unknown {
  return walk(value, scrubPatterns, new WeakSet());
}

/**
 * Builds a redactor that, besides sensitive keys, also scrubs occurrences of
 * known secret values (e.g. SANKHYA_CLIENT_SECRET) embedded anywhere in strings.
 */
export function createRedactor(secretValues: readonly string[]): <T>(value: T) => unknown {
  const secrets = [...new Set(secretValues)]
    .filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_VALUE_LENGTH)
    .sort((a, b) => b.length - a.length);

  const scrub: StringScrubber = (s) => {
    let out = s;
    for (const secret of secrets) {
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return scrubPatterns(out);
  };

  return (value) => walk(value, scrub, new WeakSet());
}

// ---------------------------------------------------------------- audit snapshots

/** Most rows a before/after audit snapshot keeps. */
export const SNAPSHOT_MAX_ROWS = 50;

/**
 * Fragments that make an ERP column sensitive wherever they appear in its name (e.g.
 * `AD_SENHA_WEB`). Column names are checked more broadly than general keys: an over-masked
 * snapshot value is harmless, a leaked credential is not.
 */
const SENSITIVE_COLUMN_FRAGMENTS = ['senha', 'password', 'passwd', 'token', 'secret'];

/** True when a column's values must never be stored in an audit snapshot (case-insensitive). */
export function isSensitiveColumn(name: string): boolean {
  if (isSensitiveKey(name)) return true;
  const k = normalizeKey(name);
  return SENSITIVE_COLUMN_FRAGMENTS.some((fragment) => k.includes(fragment));
}

export interface RedactedSnapshot {
  rows: unknown[];
  /** Rows offered before the cap was applied. */
  totalRows: number;
  /** True when rows beyond the cap were dropped. */
  truncated: boolean;
}

/**
 * Copies at most `maxRows` (never more than {@link SNAPSHOT_MAX_ROWS}) rows, masking every
 * sensitive column and scrubbing credential-shaped strings in the rest. A row that is not a
 * plain object has no column names to check and is replaced whole (fail closed).
 */
export function redactSnapshot(
  rows: readonly Record<string, unknown>[],
  maxRows: number = SNAPSHOT_MAX_ROWS,
): RedactedSnapshot {
  const cap = Math.max(0, Math.min(Math.floor(maxRows), SNAPSHOT_MAX_ROWS));
  const kept = rows.slice(0, cap).map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return REDACTED;
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (column === '__proto__' || column === 'constructor' || column === 'prototype') continue;
      out[column] = isSensitiveColumn(column) ? REDACTED : redact(value);
    }
    return out;
  });
  return { rows: kept, totalRows: rows.length, truncated: rows.length > kept.length };
}
