import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  isWeakPassword,
  isWeakSecret,
  loadConfig,
  maskSecret,
  secretValues,
} from './config';

const STRONG_SECRET = 'q8Vt2Lm9Xc4Vb8Nz1Kp5Rt3Wy6Hd0Jf7Gs';
/** Test-only random key (not used anywhere else). */
const TEST_KEY = '4tl4m1wD2VhCI5vy+SEbEYrTGmoCmfOSE1cHWXlyVBE=';
const SANKHYA_ENV = {
  SANKHYA_BASE_URL: 'https://api.sandbox.sankhya.com.br',
  SANKHYA_CLIENT_ID: 'client-id-fixture',
  SANKHYA_CLIENT_SECRET: 'client-secret-fixture-value',
  SANKHYA_X_TOKEN: 'x-token-fixture-value',
};
const PROD = {
  NODE_ENV: 'production',
  APP_URL: 'https://sql.example.com',
  DATABASE_URL: 'postgres://app:Xy7-strong-db-pass@db:5432/app',
  SESSION_SECRET: STRONG_SECRET,
  ENCRYPTION_KEY: TEST_KEY,
  SANKHYA_MODE: 'live',
};

function problemsOf(env: Record<string, string>): string[] {
  try {
    loadConfig(env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe('loadConfig', () => {
  it('uses safe defaults: read-only, writes disabled', () => {
    const c = loadConfig({});
    expect(c.safeMode).toBe(true);
    expect(c.globalWriteEnabled).toBe(false);
    expect(c.writeToSankhya).toBe(false);
    expect(c.businessActionsEnabled).toEqual([]);
    expect(c).not.toHaveProperty('ai');
    expect(c.port).toBe(3001);
    expect(c.session.hours).toBe(12);
    expect(c.session.secureCookie).toBe(false);
  });

  it('refuses NODE_ENV=test together with APP_ENV=production', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', APP_ENV: 'production' })).toThrow(ConfigError);
  });

  it('reads BUSINESS_ACTIONS_ENABLED as a list of action ids, empty when blank', () => {
    expect(loadConfig({ BUSINESS_ACTIONS_ENABLED: '' }).businessActionsEnabled).toEqual([]);
    expect(
      loadConfig({ BUSINESS_ACTIONS_ENABLED: ' CACSP.cancelarNota , ' }).businessActionsEnabled,
    ).toEqual(['CACSP.cancelarNota']);
  });

  it('treats an empty DATABASE_URL (as shipped in .env.example) as unset', () => {
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBe('pglite:memory');
  });

  it('accepts a sound production configuration and hardens cookies', () => {
    const c = loadConfig(PROD);
    expect(c.isProduction).toBe(true);
    expect(c.session.cookieName).toBe('__Host-dbx_session');
    expect(c.session.secureCookie).toBe(true);
  });

  it('refuses to boot in production with placeholder or weak secrets', () => {
    expect(problemsOf({ ...PROD, SESSION_SECRET: undefined as unknown as string }).join()).toMatch(
      /SESSION_SECRET/,
    );
    expect(
      problemsOf({
        ...PROD,
        SESSION_SECRET: 'change-me-to-a-long-random-string-at-least-32-chars',
      }).join(),
    ).toMatch(/SESSION_SECRET/);
    expect(problemsOf({ ...PROD, SESSION_SECRET: 'short' }).join()).toMatch(/SESSION_SECRET/);
    expect(problemsOf({ ...PROD, SESSION_SECRET: 'a'.repeat(64) }).join()).toMatch(
      /SESSION_SECRET/,
    );
  });

  it('refuses pglite, http APP_URL and debug logs in production', () => {
    const p = problemsOf({
      ...PROD,
      DATABASE_URL: 'pglite:memory',
      APP_URL: 'http://sql.example.com',
      LOG_LEVEL: 'debug',
    }).join('\n');
    expect(p).toMatch(/DATABASE_URL/);
    expect(p).toMatch(/APP_URL/);
    expect(p).toMatch(/LOG_LEVEL/);
    expect(
      problemsOf({ ...PROD, DATABASE_URL: 'postgres://u:change-me-db-password@db/x' }).join(),
    ).toMatch(/DATABASE_URL/);
  });

  it('refuses a TRUST_PROXY that lets direct clients spoof their IP on a public address', () => {
    for (const value of ['true', 'loopback,uniquelocal']) {
      expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: value }).join()).toMatch(
        /TRUST_PROXY/,
      );
    }
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: 'false' })).toEqual([]);
    expect(problemsOf({ ...PROD, APP_BIND: '0.0.0.0', TRUST_PROXY: '10.0.0.10' })).toEqual([]);
    expect(
      problemsOf({ ...PROD, APP_BIND: '127.0.0.1', TRUST_PROXY: 'loopback,uniquelocal' }),
    ).toEqual([]);
  });

  it('refuses hop-count TRUST_PROXY values, which Fastify ignores', () => {
    expect(problemsOf({ ...PROD, TRUST_PROXY: '1' }).join()).toMatch(/hop count/);
    expect(problemsOf({ ...PROD, TRUST_PROXY: '0' })).toEqual([]);
  });

  it('ignores unknown keys, such as settings of removed features', () => {
    expect(problemsOf({ RETIRED_FEATURE_PROVIDER: 'example' })).toEqual([]);
    expect(loadConfig({ WRITE_CONFIRMATION_TTL_SECONDS: '5' })).not.toHaveProperty(
      'writeConfirmationTtlSeconds',
    );
  });

  it('parses the bootstrap role keys and defaults to ADMIN only', () => {
    const boot = { BOOTSTRAP_ADMIN_EMAIL: 'A@example.com' };
    expect(loadConfig(boot).bootstrapAdmin).toEqual({
      email: 'a@example.com',
      name: 'Administrador',
      roles: ['ADMIN'],
    });
    expect(loadConfig({}).bootstrapAdmin.email).toBeUndefined();
    expect(
      loadConfig({ ...boot, BOOTSTRAP_ADMIN_ROLES: ' admin, operator,ADMIN' }).bootstrapAdmin.roles,
    ).toEqual(['ADMIN', 'OPERATOR']);
    expect(problemsOf({ ...boot, BOOTSTRAP_ADMIN_ROLES: 'ADMIN;DROP' }).join()).toMatch(
      /BOOTSTRAP_ADMIN_ROLES/,
    );
  });

  it('refuses the removed BOOTSTRAP_ADMIN_PASSWORD without echoing it', () => {
    const p = problemsOf({ BOOTSTRAP_ADMIN_PASSWORD: 'Boot!Strong#Pass9' }).join();
    expect(p).toMatch(/BOOTSTRAP_ADMIN_PASSWORD is no longer supported/);
    expect(p).not.toContain('Boot!Strong#Pass9');
    expect(problemsOf({ BOOTSTRAP_ADMIN_EMAIL: 'not-an-email' }).join()).toMatch(
      /BOOTSTRAP_ADMIN_EMAIL/,
    );
  });

  it('reports invalid values by variable name without echoing secrets', () => {
    const p = problemsOf({ ...PROD, SANKHYA_MAX_ROWS: 'lots', SESSION_SECRET: 'change-me' });
    expect(p.join()).toMatch(/SANKHYA_MAX_ROWS/);
    expect(p.join()).not.toContain('change-me');
  });
});

describe('secret helpers', () => {
  it('classifies weak secrets and passwords', () => {
    expect(isWeakSecret(STRONG_SECRET)).toBe(false);
    expect(isWeakSecret('dev-session-secret-not-for-production-use-0000')).toBe(true);
    expect(isWeakPassword('ChangeMe!2026')).toBe(true);
    expect(isWeakPassword('alllowercaseletters')).toBe(true);
    expect(isWeakPassword('Str0ng!Passw0rd#x')).toBe(false);
  });

  it('masks secrets and lists configured secret values', () => {
    expect(maskSecret(undefined)).toBe('(not set)');
    expect(maskSecret('abcdefghijkl')).toBe('****ijkl');
    expect(maskSecret('short')).toBe('****');
    const c = loadConfig(SANKHYA_ENV);
    expect(secretValues(c)).toEqual(
      expect.arrayContaining(['client-secret-fixture-value', 'x-token-fixture-value']),
    );
  });
});

describe('Sankhya runtime configuration', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c.safeMode).toBe(true);
    expect(c.writeToSankhya).toBe(false);
    expect(c.globalWriteEnabled).toBe(false);
    expect(c.demoMode).toBe(false);
    expect(c.planTtlSeconds).toBe(300);
    expect(c.approvalTtlMinutes).toBe(60);
    expect(() => loadConfig({ APPROVAL_TTL_MINUTES: '0' })).toThrow(/APPROVAL_TTL_MINUTES/);
    expect(c.sankhya).toMatchObject({
      mode: 'mock',
      allowedHosts: ['api.sankhya.com.br', 'api.sandbox.sankhya.com.br'],
      timeoutMs: 60000,
      ratePerMinute: 300,
      maxRows: 1000,
      envConnectionProblems: [],
    });
    expect(c.sankhya.envConnection).toBeUndefined();
    expect(c.scratch).toEqual({
      maxWorkspaces: 20,
      maxRows: 100000,
      maxTables: 20,
      ttlMinutes: 60,
      statementTimeoutMs: 10000,
    });
    expect(c.materializeMaxRows).toBe(5000);
    expect(c.customTablePrefixes).toEqual(['AD_']);
    expect(c.bootstrapTokenTtlMinutes).toBe(30);
    expect(c.encryptionKey).toHaveLength(32);
    expect(c.trustedOrigins).toEqual(['http://localhost:5173']);
  });

  it('treats APP_ENV=production as production', () => {
    expect(problemsOf({ APP_ENV: 'production' }).join()).toMatch(/AUTH_SECRET/);
    expect(
      loadConfig({ ...PROD, NODE_ENV: undefined as unknown as string, APP_ENV: 'production' })
        .isProduction,
    ).toBe(true);
  });

  it('prefers AUTH_SECRET over the legacy SESSION_SECRET', () => {
    const c = loadConfig({ AUTH_SECRET: STRONG_SECRET, SESSION_SECRET: 'other' });
    expect(c.session.secret).toBe(STRONG_SECRET);
    const { SESSION_SECRET: _drop, ...rest } = PROD;
    expect(problemsOf({ ...rest, AUTH_SECRET: STRONG_SECRET })).toEqual([]);
  });

  it('production rejects a missing, placeholder or malformed ENCRYPTION_KEY', () => {
    const { ENCRYPTION_KEY: _drop, ...noKey } = PROD;
    expect(problemsOf(noKey).join()).toMatch(/ENCRYPTION_KEY/);
    expect(problemsOf({ ...PROD, ENCRYPTION_KEY: '' }).join()).toMatch(/ENCRYPTION_KEY/);
    expect(problemsOf({ ...PROD, ENCRYPTION_KEY: 'change-me' }).join()).toMatch(/ENCRYPTION_KEY/);
    expect(
      problemsOf({ ...PROD, ENCRYPTION_KEY: Buffer.alloc(32).toString('base64') }).join(),
    ).toMatch(/ENCRYPTION_KEY/);
    expect(
      problemsOf({ ...PROD, ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64') }).join(),
    ).toMatch(/ENCRYPTION_KEY/);
  });

  it('production requires SANKHYA_MODE and allows mock only in demo mode', () => {
    const { SANKHYA_MODE: _drop, ...noMode } = PROD;
    expect(problemsOf(noMode).join()).toMatch(/SANKHYA_MODE/);
    expect(problemsOf({ ...PROD, SANKHYA_MODE: 'mock' }).join()).toMatch(/DEMO_MODE/);
    const demo = loadConfig({ ...PROD, SANKHYA_MODE: 'live', DEMO_MODE: 'true' });
    expect(demo.sankhya.mode).toBe('mock');
    expect(demo.demoMode).toBe(true);
  });

  it('rejects a rate above 1000 calls per minute', () => {
    expect(problemsOf({ SANKHYA_RATE_PER_MINUTE: '5000' }).join()).toMatch(
      /SANKHYA_RATE_PER_MINUTE/,
    );
  });

  it('starts without Sankhya credentials and reports partial ones instead of failing', () => {
    expect(loadConfig(PROD).sankhya.envConnection).toBeUndefined();
    const partial = loadConfig({ ...PROD, SANKHYA_BASE_URL: 'https://api.sankhya.com.br' });
    expect(partial.sankhya.envConnection).toBeUndefined();
    expect(partial.sankhya.envConnectionProblems.join()).toMatch(/SANKHYA_CLIENT_SECRET/);
    expect(partial.sankhya.envConnectionProblems.join()).not.toContain('api.sankhya');
  });

  it('builds the env connection only from an allowlisted https origin', () => {
    const c = loadConfig({ ...PROD, ...SANKHYA_ENV });
    expect(c.sankhya.envConnection).toEqual({
      baseUrl: 'https://api.sandbox.sankhya.com.br',
      clientId: 'client-id-fixture',
      clientSecret: 'client-secret-fixture-value',
      xToken: 'x-token-fixture-value',
      environment: 'PRODUCTION',
      dialect: 'oracle',
    });
    for (const url of [
      'http://api.sankhya.com.br',
      'https://evil.example',
      'https://u:p@api.sankhya.com.br',
      'https://api.sankhya.com.br/gateway',
    ]) {
      const bad = loadConfig({ ...PROD, ...SANKHYA_ENV, SANKHYA_BASE_URL: url });
      expect(bad.sankhya.envConnection).toBeUndefined();
      expect(bad.sankhya.envConnectionProblems.length).toBeGreaterThan(0);
    }
  });

  it('accepts PUBLIC_URL as APP_URL and adds TRUSTED_ORIGINS', () => {
    const c = loadConfig({
      PUBLIC_URL: 'https://sql.example.com',
      TRUSTED_ORIGINS: 'https://admin.example.com, https://sql.example.com',
    });
    expect(c.appOrigin).toBe('https://sql.example.com');
    expect(c.trustedOrigins).toEqual(['https://sql.example.com', 'https://admin.example.com']);
    expect(problemsOf({ TRUSTED_ORIGINS: 'https://a.example.com/path' }).join()).toMatch(
      /TRUSTED_ORIGINS/,
    );
    expect(problemsOf({ ...PROD, TRUSTED_ORIGINS: 'http://a.example.com' }).join()).toMatch(
      /TRUSTED_ORIGINS/,
    );
  });

  it('lists the encryption key and Sankhya secrets for redaction', () => {
    const c = loadConfig({ ...PROD, ...SANKHYA_ENV });
    expect(secretValues(c)).toEqual(
      expect.arrayContaining([TEST_KEY, 'client-secret-fixture-value', 'x-token-fixture-value']),
    );
  });
});
