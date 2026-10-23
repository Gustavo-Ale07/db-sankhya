import { createHash } from 'node:crypto';
import { z } from 'zod';

/** Values shipped in .env.example; production refuses to boot with them. */
export const PLACEHOLDER_SECRETS = new Set([
  'change-me-to-a-long-random-string-at-least-32-chars',
  'change-me',
  'changeme',
  'secret',
  'dev-session-secret-not-for-production-use-0000',
]);
export const PLACEHOLDER_PASSWORDS = new Set([
  'ChangeMe!2026',
  'change-me',
  'changeme',
  'admin',
  'password',
  'admin123',
]);

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? fallback : v === 'true' || v === '1' || v === 'yes',
    );

const int = (fallback: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalInt = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: 'custom', message: `must be an integer between ${min} and ${max}` });
        return z.NEVER;
      }
      return n;
    });

const optionalText = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const csv = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v === undefined || v.trim() === '' ? fallback : v)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    );

export const ENVIRONMENTS = ['PRODUCTION', 'HOMOLOGATION', 'SANDBOX'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const DEFAULT_SANKHYA_ALLOWED_HOSTS = 'api.sankhya.com.br,api.sandbox.sankhya.com.br';

/** Development-only key so local connections can be stored without setup. Production refuses it. */
const DEV_ENCRYPTION_KEY = createHash('sha256')
  .update('db-sankhya-development-only-encryption-key')
  .digest();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z
    .enum(['development', 'test', 'production', ''])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(3001, 1, 65535),
  APP_URL: optionalText,
  /** Alias of APP_URL (used when APP_URL is empty). */
  PUBLIC_URL: optionalText,
  /** Extra origins accepted for state-changing requests (comma-separated). APP_URL is always trusted. */
  TRUSTED_ORIGINS: csv(''),
  TRUST_PROXY: z.string().default('false'),
  /** Host address compose publishes the port on (read only to catch an unsafe TRUST_PROXY). */
  APP_BIND: optionalText,
  DATABASE_URL: optionalText.transform((v) => v ?? 'pglite:memory'),
  MIGRATIONS_DIR: optionalText,
  STATIC_DIR: optionalText,

  AUTH_SECRET: optionalText,
  /** Legacy name of AUTH_SECRET. */
  SESSION_SECRET: optionalText,
  /** base64 of 32 random bytes: encrypts connection secrets at rest. */
  ENCRYPTION_KEY: optionalText,
  SESSION_HOURS: int(12, 1, 24 * 30),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
  LOGIN_LOCK_MINUTES: int(15, 1, 24 * 60),

  /** Selects the admin CLI path for the first administrator (no bootstrap token is issued). */
  BOOTSTRAP_ADMIN_EMAIL: optionalText,
  /** Removed: refused when set, so nobody keeps a password in .env thinking it is used. */
  BOOTSTRAP_ADMIN_PASSWORD: optionalText,
  BOOTSTRAP_ADMIN_NAME: z.string().default('Administrador'),
  /** Comma-separated role keys of the bootstrap administrator. */
  BOOTSTRAP_ADMIN_ROLES: z
    .string()
    .default('ADMIN')
    .transform((v) => [...new Set(v.split(',').map((s) => s.trim().toUpperCase()))].filter(Boolean))
    .pipe(z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'invalid role key')).min(1)),

  SANKHYA_MODE: z
    .enum(['mock', 'live', ''])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
  DEMO_MODE: bool(false),
  SAFE_MODE: bool(true),
  WRITE_TO_SANKHYA: bool(false),
  GLOBAL_WRITE_ENABLED: bool(false),
  /**
   * Master switch for the server-side ("Executa Banco") execution path (DDL, DELETE, MERGE,
   * INSERT…SELECT, expression UPDATE, DCL, PL/SQL). Off by default; HOMOLOGATION/SANDBOX only.
   */
  SERVER_SQL_ENABLED: bool(false),
  /** Separate, explicit opt-in before the server-side path may run against PRODUCTION. */
  SERVER_SQL_PRODUCTION_OPT_IN: bool(false),
  /**
   * Business action ids (e.g. `CACSP.cancelarNota`) allowed on `live` connections. Empty (the
   * default) disables every action on a live connection: fail closed.
   */
  BUSINESS_ACTIONS_ENABLED: csv(''),
  PLAN_TTL_SECONDS: int(300, 30, 3600),
  /** Lifetime of a plan that requires approval (four eyes), in minutes. */
  APPROVAL_TTL_MINUTES: int(60, 1, 24 * 60),
  /** Settled plans lose their before values and preview after this many hours. */
  PLAN_REDACT_HOURS: int(24, 1, 30 * 24),
  /** Settled plans without an approval request are deleted after this many days. */
  PLAN_RETENTION_DAYS: int(30, 1, 3650),
  SANKHYA_BASE_URL: optionalText,
  SANKHYA_CLIENT_ID: optionalText,
  SANKHYA_CLIENT_SECRET: optionalText,
  SANKHYA_X_TOKEN: optionalText,
  SANKHYA_ENVIRONMENT: z
    .enum([...ENVIRONMENTS, ''])
    .optional()
    .transform((v) => (v === '' || v === undefined ? 'PRODUCTION' : v)),
  SANKHYA_DIALECT: z
    .enum(['oracle', 'mssql', ''])
    .optional()
    .transform((v) => (v === '' || v === undefined ? 'oracle' : v)),
  SANKHYA_ALLOWED_HOSTS: csv(DEFAULT_SANKHYA_ALLOWED_HOSTS),
  SANKHYA_TIMEOUT_MS: int(60_000, 1000, 600_000),
  SANKHYA_RATE_PER_MINUTE: int(300, 1, 1000),
  SANKHYA_MAX_ROWS: int(1000, 1, 100_000),
  /**
   * Test-only switches of the built-in mock gateway (row cap, silent cut, dictionary padding), to
   * reproduce a gateway that cuts the data dictionary. Refused unless SANKHYA_MODE=mock outside
   * production.
   */
  SANKHYA_MOCK_ROW_CAP: optionalInt(1, 100_000),
  SANKHYA_MOCK_SILENT_CUT: bool(false),
  SANKHYA_MOCK_DICTIONARY_PADDING: optionalInt(0, 100_000),
  /** File the mock appends each gateway call's service name to (the E2E asserts no write call). */
  SANKHYA_MOCK_CALL_LOG: optionalText,
  SCRATCH_MAX_WORKSPACES: int(20, 1, 1000),
  SCRATCH_MAX_ROWS: int(100_000, 100, 10_000_000),
  SCRATCH_MAX_TABLES: int(20, 1, 500),
  SCRATCH_TTL_MINUTES: int(60, 1, 7 * 24 * 60),
  SCRATCH_STATEMENT_TIMEOUT_MS: int(10_000, 100, 600_000),
  MATERIALIZE_MAX_ROWS: int(5000, 1, 1_000_000),
  /** How long an incomplete (degraded) catalog is served before it is read again. */
  METADATA_DEGRADED_TTL_SECONDS: int(600, 10, 3600),
  /** Pages of one dictionary read (TDDTAB, TDDCAM) before it is reported as cut. */
  METADATA_MAX_PAGES: int(100, 1, 1000),
  CUSTOM_TABLE_PREFIXES: csv('AD_'),
  BOOTSTRAP_TOKEN_TTL_MINUTES: int(30, 1, 24 * 60),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  APP_VERSION: optionalText,
  GIT_COMMIT: optionalText,
});

export type Env = z.output<typeof envSchema>;

/** Credentials of the connection defined by SANKHYA_* variables (never persisted). */
export interface EnvSankhyaConnection {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  xToken: string;
  environment: Environment;
  dialect: 'oracle' | 'mssql';
}

export interface SankhyaConfig {
  mode: 'mock' | 'live';
  allowedHosts: string[];
  timeoutMs: number;
  ratePerMinute: number;
  /** Rows a read returns at most (the result is flagged as truncated beyond it). */
  maxRows: number;
  /** SANKHYA_MOCK_*: options of the built-in mock gateway, empty unless a test sets them. */
  mockGateway: {
    queryRowCap?: number;
    silentCut?: boolean;
    dictionaryPadding?: number;
    /** File each gateway call's service name is appended to (never its body). */
    callLog?: string;
  };
  /** Set only when every SANKHYA_* credential is present. */
  envConnection?: EnvSankhyaConnection;
  /**
   * Why the env connection is unusable (missing or invalid variables). The app still starts and
   * reports the connection as not configured instead of refusing to boot.
   */
  envConnectionProblems: string[];
}

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  host: string;
  port: number;
  appUrl: string;
  appOrigin: string;
  /** Origins accepted for state-changing requests: APP_URL's plus TRUSTED_ORIGINS. */
  trustedOrigins: string[];
  /** 32-byte key for secrets at rest. */
  encryptionKey: Buffer;
  safeMode: boolean;
  writeToSankhya: boolean;
  globalWriteEnabled: boolean;
  /** SERVER_SQL_ENABLED: master switch for the server-side execution path (off by default). */
  serverSqlEnabled: boolean;
  /** SERVER_SQL_PRODUCTION_OPT_IN: separate opt-in before the server-side path touches PRODUCTION. */
  serverSqlProductionOptIn: boolean;
  /** BUSINESS_ACTIONS_ENABLED: action ids allowed on live connections (empty: none). */
  businessActionsEnabled: string[];
  demoMode: boolean;
  planTtlSeconds: number;
  /** APPROVAL_TTL_MINUTES: lifetime of plans that require approval. */
  approvalTtlMinutes: number;
  /** PLAN_REDACT_HOURS / PLAN_RETENTION_DAYS: housekeeping of settled plans (purgePlans). */
  planRedactHours: number;
  planRetentionDays: number;
  sankhya: SankhyaConfig;
  scratch: {
    maxWorkspaces: number;
    maxRows: number;
    maxTables: number;
    ttlMinutes: number;
    statementTimeoutMs: number;
  };
  materializeMaxRows: number;
  /** METADATA_DEGRADED_TTL_SECONDS: how long an incomplete catalog is served before a new read. */
  metadataDegradedTtlSeconds: number;
  /** METADATA_MAX_PAGES: pages of one dictionary read before it is reported as cut. */
  metadataMaxPages: number;
  customTablePrefixes: string[];
  bootstrapTokenTtlMinutes: number;
  trustProxy: boolean | string;
  databaseUrl: string;
  migrationsDir?: string;
  staticDir?: string;
  session: {
    secret: string;
    hours: number;
    cookieName: string;
    secureCookie: boolean;
    loginMaxAttempts: number;
    loginLockMinutes: number;
  };
  /**
   * The first administrator. `email` (BOOTSTRAP_ADMIN_EMAIL) selects the admin CLI path; without
   * it an empty users table gets a one-time bootstrap token. Never holds a password.
   */
  bootstrapAdmin: { email?: string; name: string; roles: string[] };
  logLevel: Env['LOG_LEVEL'];
  version: string;
  commit: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
  }
}

function isLoopback(host: string): boolean {
  const h = host.trim().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h.startsWith('127.');
}

function parseTrustProxy(value: string): boolean | string {
  const v = value.trim();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  // Comma-separated trusted addresses, CIDRs or proxy-addr names (loopback, uniquelocal, …).
  // A hop count is rejected in loadConfig: Fastify ignores it and every client would get the proxy IP.
  return v;
}

/** Rough strength check: length plus character variety, so "aaaa…" or a word list fails. */
export function isWeakSecret(secret: string): boolean {
  if (secret.length < 32) return true;
  if (PLACEHOLDER_SECRETS.has(secret)) return true;
  if (/change[-_ ]?me/i.test(secret)) return true;
  return new Set(secret).size < 12;
}

export function isWeakPassword(password: string): boolean {
  if (password.length < 12) return true;
  if (PLACEHOLDER_PASSWORDS.has(password)) return true;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  return classes < 3;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  // NODE_ENV=test enables cheap password hashing; never together with a production marker.
  if (e.NODE_ENV === 'test' && e.APP_ENV === 'production')
    throw new ConfigError(['NODE_ENV=test is not allowed when APP_ENV=production']);
  const problems: string[] = [];
  const isProduction = e.NODE_ENV === 'production' || e.APP_ENV === 'production';
  const rawAppUrl = e.APP_URL ?? e.PUBLIC_URL ?? 'http://localhost:5173';
  const appUrl = parseUrl(rawAppUrl);
  if (!appUrl) throw new ConfigError(['APP_URL must be an absolute http(s) URL']);
  const trustedOrigins = [appUrl.origin];
  for (const value of e.TRUSTED_ORIGINS) {
    const u = parseUrl(value);
    if (!u || u.origin !== value.replace(/\/+$/, '')) {
      problems.push(
        'TRUSTED_ORIGINS must be a comma-separated list of origins (scheme://host[:port])',
      );
      break;
    }
    if (isProduction && u.protocol !== 'https:')
      problems.push('TRUSTED_ORIGINS must use https:// in production');
    if (!trustedOrigins.includes(u.origin)) trustedOrigins.push(u.origin);
  }
  const authSecret =
    e.AUTH_SECRET ?? e.SESSION_SECRET ?? 'dev-session-secret-not-for-production-use-0000';
  const encryptionKey = decodeKey(e.ENCRYPTION_KEY);
  const sankhyaMode = e.DEMO_MODE
    ? 'mock'
    : (e.SANKHYA_MODE ?? (isProduction ? undefined : 'mock'));
  if (!sankhyaMode) problems.push('SANKHYA_MODE (live or mock) is required in production');
  if (isProduction && sankhyaMode === 'mock' && !e.DEMO_MODE)
    problems.push('SANKHYA_MODE=mock is only allowed in production together with DEMO_MODE=true');
  if (isProduction) {
    if (!e.ENCRYPTION_KEY) problems.push('ENCRYPTION_KEY is required in production');
    else if (!encryptionKey || isWeakKey(encryptionKey))
      problems.push(
        'ENCRYPTION_KEY must be base64 of 32 random bytes (generate with: openssl rand -base64 32)',
      );
  } else if (e.ENCRYPTION_KEY && !encryptionKey) {
    problems.push('ENCRYPTION_KEY must be base64 of 32 bytes');
  }
  const mockGateway = {
    ...(e.SANKHYA_MOCK_ROW_CAP !== undefined ? { queryRowCap: e.SANKHYA_MOCK_ROW_CAP } : {}),
    ...(e.SANKHYA_MOCK_SILENT_CUT ? { silentCut: true } : {}),
    ...(e.SANKHYA_MOCK_DICTIONARY_PADDING !== undefined
      ? { dictionaryPadding: e.SANKHYA_MOCK_DICTIONARY_PADDING }
      : {}),
    ...(e.SANKHYA_MOCK_CALL_LOG ? { callLog: e.SANKHYA_MOCK_CALL_LOG } : {}),
  };
  if (Object.keys(mockGateway).length && (isProduction || sankhyaMode !== 'mock'))
    problems.push(
      'SANKHYA_MOCK_* are test-only: set them only with SANKHYA_MODE=mock outside production',
    );
  const envConnection = readEnvConnection(e);
  const trust = parseTrustProxy(e.TRUST_PROXY);
  if (typeof trust === 'string' && /^\d+$/.test(trust)) {
    problems.push(
      'TRUST_PROXY hop counts are not supported (every client would get the proxy IP): use loopback,uniquelocal behind a local reverse proxy, or the proxy addresses',
    );
  }

  if (isProduction) {
    if (!(e.AUTH_SECRET ?? e.SESSION_SECRET) || isWeakSecret(authSecret)) {
      problems.push(
        'AUTH_SECRET (legacy name SESSION_SECRET) is missing, a placeholder or too weak (use at least 32 random characters)',
      );
    }
    if (e.DATABASE_URL.startsWith('pglite:'))
      problems.push('DATABASE_URL must point to PostgreSQL in production');
    if (/change-?me/i.test(e.DATABASE_URL))
      problems.push('DATABASE_URL still contains the placeholder database password');
    if (appUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(appUrl.hostname)) {
      problems.push('APP_URL must use https:// in production');
    }
    if (e.LOG_LEVEL === 'trace' || e.LOG_LEVEL === 'debug')
      problems.push('LOG_LEVEL debug/trace is not allowed in production');
    // Published directly, clients reach the app through Docker's NAT with a private source address,
    // so trusting everything or the private ranges would let them spoof X-Forwarded-For.
    if (
      e.APP_BIND &&
      !isLoopback(e.APP_BIND) &&
      (trust === true || (typeof trust === 'string' && /uniquelocal/i.test(trust)))
    )
      problems.push(
        'TRUST_PROXY must be false or a list of proxy addresses when APP_BIND exposes the app directly (clients could spoof their IP)',
      );
  }

  if (e.BOOTSTRAP_ADMIN_EMAIL && !z.email().safeParse(e.BOOTSTRAP_ADMIN_EMAIL).success) {
    problems.push('BOOTSTRAP_ADMIN_EMAIL is not a valid e-mail');
  }
  if (e.BOOTSTRAP_ADMIN_PASSWORD) {
    problems.push(
      'BOOTSTRAP_ADMIN_PASSWORD is no longer supported: remove it and create the first administrator with the bootstrap token or the admin CLI',
    );
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    isProduction,
    host: e.HOST,
    port: e.PORT,
    appUrl: appUrl.toString().replace(/\/+$/, ''),
    appOrigin: appUrl.origin,
    trustedOrigins,
    encryptionKey: encryptionKey ?? DEV_ENCRYPTION_KEY,
    safeMode: e.SAFE_MODE,
    writeToSankhya: e.WRITE_TO_SANKHYA,
    globalWriteEnabled: e.GLOBAL_WRITE_ENABLED,
    serverSqlEnabled: e.SERVER_SQL_ENABLED,
    serverSqlProductionOptIn: e.SERVER_SQL_PRODUCTION_OPT_IN,
    businessActionsEnabled: e.BUSINESS_ACTIONS_ENABLED,
    demoMode: e.DEMO_MODE,
    planTtlSeconds: e.PLAN_TTL_SECONDS,
    approvalTtlMinutes: e.APPROVAL_TTL_MINUTES,
    planRedactHours: e.PLAN_REDACT_HOURS,
    planRetentionDays: e.PLAN_RETENTION_DAYS,
    sankhya: {
      mode: sankhyaMode ?? 'live',
      allowedHosts: e.SANKHYA_ALLOWED_HOSTS.map((h) => h.toLowerCase()),
      timeoutMs: e.SANKHYA_TIMEOUT_MS,
      ratePerMinute: e.SANKHYA_RATE_PER_MINUTE,
      maxRows: e.SANKHYA_MAX_ROWS,
      mockGateway,
      ...(envConnection.connection ? { envConnection: envConnection.connection } : {}),
      envConnectionProblems: envConnection.problems,
    },
    scratch: {
      maxWorkspaces: e.SCRATCH_MAX_WORKSPACES,
      maxRows: e.SCRATCH_MAX_ROWS,
      maxTables: e.SCRATCH_MAX_TABLES,
      ttlMinutes: e.SCRATCH_TTL_MINUTES,
      statementTimeoutMs: e.SCRATCH_STATEMENT_TIMEOUT_MS,
    },
    materializeMaxRows: e.MATERIALIZE_MAX_ROWS,
    metadataDegradedTtlSeconds: e.METADATA_DEGRADED_TTL_SECONDS,
    metadataMaxPages: e.METADATA_MAX_PAGES,
    customTablePrefixes: e.CUSTOM_TABLE_PREFIXES.map((p) => p.toUpperCase()),
    bootstrapTokenTtlMinutes: e.BOOTSTRAP_TOKEN_TTL_MINUTES,
    trustProxy: trust,
    databaseUrl: e.DATABASE_URL,
    ...(e.MIGRATIONS_DIR ? { migrationsDir: e.MIGRATIONS_DIR } : {}),
    ...(e.STATIC_DIR ? { staticDir: e.STATIC_DIR } : {}),
    session: {
      secret: authSecret,
      hours: e.SESSION_HOURS,
      // __Host- prefix forces Secure, Path=/ and no Domain in browsers.
      cookieName: isProduction ? '__Host-dbx_session' : 'dbx_session',
      secureCookie: isProduction,
      loginMaxAttempts: e.LOGIN_MAX_ATTEMPTS,
      loginLockMinutes: e.LOGIN_LOCK_MINUTES,
    },
    bootstrapAdmin: {
      ...(e.BOOTSTRAP_ADMIN_EMAIL ? { email: e.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() } : {}),
      name: e.BOOTSTRAP_ADMIN_NAME,
      roles: e.BOOTSTRAP_ADMIN_ROLES,
    },
    logLevel: e.LOG_LEVEL,
    version: e.APP_VERSION ?? process.env.npm_package_version ?? '0.1.0',
    commit: e.GIT_COMMIT ?? 'dev',
  };
}

/** Every configured secret value, for value-based redaction in logs and traces. */
export function secretValues(config: AppConfig): string[] {
  const env = config.sankhya.envConnection;
  return [
    config.session.secret,
    config.encryptionKey.toString('base64'),
    env?.clientId,
    env?.clientSecret,
    env?.xToken,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Masks a secret for display: never more than the last 4 characters. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '(not set)';
  return secret.length <= 8 ? '****' : `****${secret.slice(-4)}`;
}

function parseUrl(value: string): URL | undefined {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u : undefined;
  } catch {
    return undefined;
  }
}

function decodeKey(value: string | undefined): Buffer | undefined {
  if (!value || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return undefined;
  const key = Buffer.from(value, 'base64');
  return key.length === 32 ? key : undefined;
}

/** A key with little variety (all zeros, a repeated pattern) is a placeholder, not random. */
function isWeakKey(key: Buffer): boolean {
  return new Set(key).size < 16;
}

const ENV_CONNECTION_VARS = [
  'SANKHYA_BASE_URL',
  'SANKHYA_CLIENT_ID',
  'SANKHYA_CLIENT_SECRET',
  'SANKHYA_X_TOKEN',
] as const;

/**
 * The connection defined by environment variables. Missing or invalid values never stop the app:
 * they are reported so the UI can show the connection as not configured.
 */
function readEnvConnection(e: Env): { connection?: EnvSankhyaConnection; problems: string[] } {
  const missing = ENV_CONNECTION_VARS.filter((name) => !e[name]);
  if (missing.length === ENV_CONNECTION_VARS.length) return { problems: [] };
  if (missing.length > 0) return { problems: missing.map((name) => `${name} is not set`) };
  const url = parseUrl(e.SANKHYA_BASE_URL!);
  const problems: string[] = [];
  if (!url) problems.push('SANKHYA_BASE_URL is not a valid URL');
  else {
    if (url.protocol !== 'https:') problems.push('SANKHYA_BASE_URL must use https://');
    if (url.username || url.password)
      problems.push('SANKHYA_BASE_URL must not contain credentials');
    if (url.pathname !== '/' || url.search || url.hash)
      problems.push('SANKHYA_BASE_URL must be an origin only (https://host)');
    const allowed = e.SANKHYA_ALLOWED_HOSTS.map((h) => h.toLowerCase());
    if (!allowed.includes(url.hostname.toLowerCase()))
      problems.push('SANKHYA_BASE_URL host is not in SANKHYA_ALLOWED_HOSTS');
  }
  if (problems.length > 0 || !url) return { problems };
  return {
    connection: {
      baseUrl: url.origin,
      clientId: e.SANKHYA_CLIENT_ID!,
      clientSecret: e.SANKHYA_CLIENT_SECRET!,
      xToken: e.SANKHYA_X_TOKEN!,
      environment: e.SANKHYA_ENVIRONMENT,
      dialect: e.SANKHYA_DIALECT,
    },
    problems: [],
  };
}
