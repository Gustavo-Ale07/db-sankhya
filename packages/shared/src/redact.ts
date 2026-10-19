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
// `password=x`, `senha: x`, `"client_secret":"x"` in free text (query strings, upstream bodies).
// A separator (= or :) is required, so prose such as "the token expired" is kept.
const KEY_VALUE_PATTERN =
  /\b((?:[a-z0-9]+[_-]?)?(?:password|passwd|senha|secret|token|api[_-]?key))("?\s*[=:]\s*"?)([^\s&;,"']+)/gi;

/** Scrubs credential-shaped substrings that no key name or configured value would catch. */
function scrubPatterns(s: string): string {
  return s
    .replace(BEARER_PATTERN, (match, word: string, credential: string) =>
      /^[a-z]+$/.test(credential) ? match : `${word} ${REDACTED}`,
    )
    .replace(JWT_PATTERN, REDACTED)
    .replace(KEY_VALUE_PATTERN, (match, key: string, sep: string, value: string) =>
      value === REDACTED ? match : `${key}${sep}${REDACTED}`,
    );
}

type KeyMatcher = (key: string) => boolean;
type KeyScrubber = (key: string) => string;

const keepKey: KeyScrubber = (key) => key;

function walk(
  value: unknown,
  scrub: StringScrubber,
  seen: WeakSet<object>,
  sensitive: KeyMatcher = isSensitiveKey,
  scrubKey: KeyScrubber = keepKey,
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, scrub, seen, sensitive, scrubKey));
  }
  const copyEntries = (target: Record<string, unknown>, source: object): void => {
    for (const [rawKey, child] of Object.entries(source)) {
      const key = scrubKey(rawKey);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      target[key] =
        sensitive(key) || sensitive(rawKey)
          ? REDACTED
          : walk(child, scrub, seen, sensitive, scrubKey);
    }
  };
  if (value instanceof Error) {
    // Own enumerable props miss message/stack; keep them (scrubbed).
    const err: Record<string, unknown> = { name: value.name, message: scrub(value.message) };
    if (value.stack) err.stack = scrub(value.stack);
    copyEntries(err, value);
    return err;
  }

  const out: Record<string, unknown> = {};
  copyEntries(out, value);
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
/** Longest string value a snapshot keeps; longer ones are clipped and end with `…`. */
export const SNAPSHOT_MAX_STRING_CHARS = 2000;
/** Largest serialized (UTF-8 JSON) size of one snapshot. */
export const SNAPSHOT_MAX_BYTES = 256 * 1024;

/**
 * Fragments that make a key sensitive wherever they appear in it (e.g. `AD_SENHA_WEB`,
 * `authorizationHeader`, `client_secret_enc`). Audit data is checked more broadly than log
 * keys: an over-masked audit value is harmless, a leaked credential is not.
 */
const SENSITIVE_COLUMN_FRAGMENTS = [
  'senha',
  'password',
  'passwd',
  'token',
  'secret',
  'cookie',
  'session',
  'authorization',
  'bearer',
  'apikey',
  'credential',
];

/**
 * True when a column's or audit key's values must never be stored (case-insensitive,
 * separators ignored, matched anywhere in the name).
 */
export function isSensitiveColumn(name: string): boolean {
  if (isSensitiveKey(name)) return true;
  const k = normalizeKey(name);
  return SENSITIVE_COLUMN_FRAGMENTS.some((fragment) => k.includes(fragment));
}

/** Options for {@link redactBroad}. */
export interface RedactBroadOptions {
  /** Clip every string to {@link SNAPSHOT_MAX_STRING_CHARS} characters (plus `…`). */
  clipStrings?: boolean;
}

/**
 * Like {@link redact}, but masks every key that merely contains a sensitive word, at any depth.
 * Used for audit JSON (snapshots, details, policy decisions, verification results). In string
 * values and object keys, lone UTF-16 surrogates become U+FFFD and NUL is stripped, since
 * PostgreSQL jsonb rejects both.
 */
export function redactBroad<T>(value: T, options: RedactBroadOptions = {}): unknown {
  return walk(
    value,
    options.clipStrings ? clipString : scrubAuditString,
    new WeakSet(),
    isSensitiveColumn,
    jsonbSafe,
  );
}

export interface RedactedSnapshot {
  rows: unknown[];
  /** Rows offered before any cap was applied. */
  totalRows: number;
  /** True when rows were dropped by the row cap or the byte cap. */
  truncated: boolean;
  /** Serialized bytes of the rows dropped because of the byte cap (0 when none). */
  truncatedBytes: number;
}

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// eslint-disable-next-line no-control-regex -- NUL is exactly what must be removed.
const NUL = /\u0000/g;

/**
 * Replaces lone surrogates with U+FFFD and strips NUL. PostgreSQL rejects both, in jsonb and
 * in text columns alike.
 */
export function jsonbSafe(s: string): string {
  return s.replace(LONE_SURROGATES, '�').replace(NUL, '');
}

/**
 * Normalizes first, then scrubs: stripping NUL after scrubbing could rebuild a credential that
 * NUL had split (`Bear\0er x`, `pass\0word=x`) and store it in clear.
 */
const scrubAuditString: StringScrubber = (s) => scrubPatterns(jsonbSafe(s));

const clipString: StringScrubber = (s) => {
  const scrubbed = scrubAuditString(s);
  if (scrubbed.length <= SNAPSHOT_MAX_STRING_CHARS) return scrubbed;
  let head = scrubbed.slice(0, SNAPSHOT_MAX_STRING_CHARS);
  // The cut may split a surrogate pair: drop the orphaned high surrogate.
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
  return `${head}…`;
};

/**
 * UTF-8 byte length of a string, counted per code point. A lone surrogate would count 3 bytes;
 * audit strings never hold one (they become U+FFFD), and JSON.stringify escapes any other as a
 * 6-byte `\uXXXX` sequence.
 */
export function utf8ByteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

const byteLength = (value: unknown): number => utf8ByteLength(JSON.stringify(value) ?? '');

/** Room kept for the envelope ({rows, totalRows, truncated, truncatedBytes}). */
const SNAPSHOT_ENVELOPE_BYTES = 128;

/**
 * Copies at most `maxRows` (never more than {@link SNAPSHOT_MAX_ROWS}) rows, masking every key
 * that contains a sensitive word at any depth, scrubbing credential-shaped strings and clipping
 * long strings. Rows that would push the serialized snapshot past `maxBytes` (never more than
 * {@link SNAPSHOT_MAX_BYTES}) are dropped; a single row wider than the cap is dropped too. A row
 * that is not a plain object has no column names to check and is replaced whole (fail closed).
 */
export function redactSnapshot(
  rows: readonly Record<string, unknown>[],
  maxRows: number = SNAPSHOT_MAX_ROWS,
  maxBytes: number = SNAPSHOT_MAX_BYTES,
): RedactedSnapshot {
  const cap = Math.max(0, Math.min(Math.floor(maxRows), SNAPSHOT_MAX_ROWS));
  const budget = Math.min(maxBytes, SNAPSHOT_MAX_BYTES) - SNAPSHOT_ENVELOPE_BYTES;
  const kept: unknown[] = [];
  let used = 2; // the array brackets
  let truncatedBytes = 0;
  for (const row of rows.slice(0, cap)) {
    const copy =
      row === null || typeof row !== 'object' || Array.isArray(row)
        ? REDACTED
        : walk(row, clipString, new WeakSet(), isSensitiveColumn, jsonbSafe);
    const size = byteLength(copy) + (kept.length ? 1 : 0); // comma separator
    if (truncatedBytes > 0 || used + size > budget) {
      truncatedBytes += size;
      continue;
    }
    kept.push(copy);
    used += size;
  }
  return {
    rows: kept,
    totalRows: rows.length,
    truncated: rows.length > kept.length,
    truncatedBytes,
  };
}

export interface RedactedSnapshotPair {
  before?: RedactedSnapshot;
  after?: RedactedSnapshot;
}

/**
 * Redacts the before and after rows of one audit event under a single
 * {@link SNAPSHOT_MAX_BYTES} budget (the cap is per audit row): `after` gets whatever `before`
 * left over. Absent sides are omitted.
 */
export function redactSnapshotPair(input: {
  before?: readonly Record<string, unknown>[];
  after?: readonly Record<string, unknown>[];
}): RedactedSnapshotPair {
  const out: RedactedSnapshotPair = {};
  let remaining = SNAPSHOT_MAX_BYTES;
  if (input.before !== undefined) {
    out.before = redactSnapshot(input.before, SNAPSHOT_MAX_ROWS, remaining);
    remaining -= byteLength(out.before);
  }
  if (input.after !== undefined)
    out.after = redactSnapshot(input.after, SNAPSHOT_MAX_ROWS, remaining);
  return out;
}
