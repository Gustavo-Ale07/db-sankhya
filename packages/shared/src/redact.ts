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

const SENSITIVE_SUFFIXES = ['token', 'apikey', 'secret', 'password'];

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
