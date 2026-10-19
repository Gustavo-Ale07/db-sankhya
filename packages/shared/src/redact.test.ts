import { describe, expect, it } from 'vitest';
import {
  REDACTED,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_MAX_ROWS,
  SNAPSHOT_MAX_STRING_CHARS,
  createRedactor,
  isSensitiveColumn,
  isSensitiveKey,
  redact,
  redactBroad,
  redactSnapshot,
  utf8ByteLength,
} from './redact';

const MID_WORD_NAMES = [
  'senhaAntiga',
  'client_secret_enc',
  'cookies',
  'authorizationHeader',
  'SessionCookie',
  'passwordConfirm',
  'x_token_enc',
  'apiKeyValue',
  'AD_COOKIE_WEB',
  'SESSION_KEY',
  'AUTHORIZATION_CODE',
];

describe('broad (contains) matching for audit data', () => {
  it('treats names containing a sensitive word anywhere as sensitive', () => {
    for (const name of [...MID_WORD_NAMES, 'bearerValue', 'USER_CREDENTIALS'])
      expect(isSensitiveColumn(name), name).toBe(true);
  });

  it('masks mid-word names in snapshot rows', () => {
    const row = Object.fromEntries(MID_WORD_NAMES.map((n) => [n, `value-of-${n}`]));
    const out = redactSnapshot([{ ID: 1, ...row }]);
    expect(out.rows[0]).toEqual({
      ID: 1,
      ...Object.fromEntries(MID_WORD_NAMES.map((n) => [n, REDACTED])),
    });
  });

  it('masks sensitive keys inside nested objects and arrays of snapshot values', () => {
    const out = redactSnapshot([
      {
        ID: 1,
        META: { owner: 'x', senhaAntiga: 'n1', inner: [{ apiKeyValue: 'n2', ok: 1 }] },
        LIST: [{ SessionCookie: 'n3' }, 'plain', ['deep', { x_token_enc: 'n4' }]],
      },
    ]);
    expect(out.rows[0]).toEqual({
      ID: 1,
      META: { owner: 'x', senhaAntiga: REDACTED, inner: [{ apiKeyValue: REDACTED, ok: 1 }] },
      LIST: [{ SessionCookie: REDACTED }, 'plain', ['deep', { x_token_enc: REDACTED }]],
    });
  });

  it('redactBroad masks nested mid-word keys and scrubs credentials in strings', () => {
    const out = redactBroad({
      reason: 'sent Bearer abc.def.ghi1 upstream',
      rules: [{ id: 'r1', AUTHORIZATION_CODE: 'n1' }],
      ctx: { cookies: 'n2', nested: { client_secret_enc: 'n3' } },
    });
    expect(out).toEqual({
      reason: `sent Bearer ${REDACTED} upstream`,
      rules: [{ id: 'r1', AUTHORIZATION_CODE: REDACTED }],
      ctx: { cookies: REDACTED, nested: { client_secret_enc: REDACTED } },
    });
  });
});

describe('snapshot size bounds', () => {
  it('clips long string values to 2000 characters with a marker', () => {
    expect(SNAPSHOT_MAX_STRING_CHARS).toBe(2000);
    const out = redactSnapshot([{ ID: 1, OBS: 'a'.repeat(5000), NESTED: { t: 'b'.repeat(3000) } }]);
    const row = out.rows[0] as { OBS: string; NESTED: { t: string } };
    expect(row.OBS).toBe(`${'a'.repeat(2000)}…`);
    expect(row.NESTED.t).toBe(`${'b'.repeat(2000)}…`);
    expect(out.truncated).toBe(false);
  });

  it('caps the serialized snapshot at 256 KB and records the dropped bytes', () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(256 * 1024);
    // 50 rows x 10 columns x 2000 chars is about 1 MB before the byte cap.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ID: i,
      ...Object.fromEntries(Array.from({ length: 10 }, (_, c) => [`C${c}`, 'x'.repeat(2000)])),
    }));
    const out = redactSnapshot(rows);
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.rows.length).toBeLessThan(50);
    expect(out.truncated).toBe(true);
    expect(out.truncatedBytes).toBeGreaterThan(0);
    expect(out.totalRows).toBe(50);
  });

  it('drops a single row wider than the cap instead of storing it', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 300 }, (_, c) => [`COL_${c}`, 'y'.repeat(1999)]),
    );
    const out = redactSnapshot([wide]);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(true);
    expect(out.truncatedBytes).toBeGreaterThan(SNAPSHOT_MAX_BYTES);
  });

  it('counts multi-byte characters as bytes', () => {
    // 2000 two-byte characters per value: about 1 MB in UTF-8, under 256 K in UTF-16 units.
    const rows = Array.from({ length: 50 }, () =>
      Object.fromEntries(Array.from({ length: 5 }, (_, c) => [`T${c}`, 'ç'.repeat(2000)])),
    );
    const out = redactSnapshot(rows);
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
  });

  it('measures UTF-8 bytes per code point', () => {
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('ç')).toBe(2);
    expect(utf8ByteLength('€')).toBe(3);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('aç€😀')).toBe(10);
  });

  it('reports no truncatedBytes when nothing was dropped for size', () => {
    expect(redactSnapshot([{ ID: 1 }]).truncatedBytes).toBe(0);
  });
});

describe('redact', () => {
  it('replaces sensitive keys at any depth, case-insensitively', () => {
    const input = {
      serviceName: 'DbExplorerSP.executeQuery',
      client_secret: '123',
      CLIENT_SECRET: 'abc',
      requestBody: [{ page: 1, nested: { password: 'x', Authorization: 'Bearer t' } }],
      headers: { cookie: 'sid=1', 'set-cookie': ['a'], 'x-api-key': 'k', 'x-token': 't' },
    };
    expect(redact(input)).toEqual({
      serviceName: 'DbExplorerSP.executeQuery',
      client_secret: REDACTED,
      CLIENT_SECRET: REDACTED,
      requestBody: [{ page: 1, nested: { password: REDACTED, Authorization: REDACTED } }],
      headers: {
        cookie: REDACTED,
        'set-cookie': REDACTED,
        'x-api-key': REDACTED,
        'x-token': REDACTED,
      },
    });
  });

  it('covers token, api_key and suffixed key names', () => {
    const out = redact({
      token: 't',
      session_token: 's',
      api_key: 'a',
      provider_api_key: 'o',
      SERVICE_API_KEY: 'n',
      sessionSecret: 'z',
      confirmationToken: 'c',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('redacts sankhya credential keys', () => {
    const out = redact({
      client_secret: 'a',
      'X-Token': 'b',
      access_token: 'c',
      refresh_token: 'd',
      JSESSIONID: 'e',
      mgeSession: 'f',
      nested: { Authorization: 'Bearer g' },
    });
    expect(out).toEqual({
      client_secret: REDACTED,
      'X-Token': REDACTED,
      access_token: REDACTED,
      refresh_token: REDACTED,
      JSESSIONID: REDACTED,
      mgeSession: REDACTED,
      nested: { Authorization: REDACTED },
    });
  });

  it('redacts the bare session key but keeps session ids and other session fields', () => {
    expect(
      redact({ session: 'opaque-session-value', Session: { id: 'x' }, session_id: 'sid-1' }),
    ).toEqual({ session: REDACTED, Session: REDACTED, session_id: REDACTED });
    // Keys that merely contain "session" are not secrets by name.
    expect(redact({ sessionHours: 12, sessions: 3, sessionExpiresAt: 'later' })).toEqual({
      sessionHours: 12,
      sessions: 3,
      sessionExpiresAt: 'later',
    });
  });

  it('redacts bearer tokens and JWTs inside free text', () => {
    expect(redact({ message: 'sent Bearer eyJabc.def.ghi to gateway' })).toEqual({
      message: `sent Bearer ${REDACTED} to gateway`,
    });
    expect(redact('header was bearer abc123+/=, retrying')).toBe(
      `header was bearer ${REDACTED}, retrying`,
    );
    expect(redact('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl leaked')).toBe(
      `token ${REDACTED} leaked`,
    );
    expect(createRedactor([])('Bearer abc.def')).toBe(`Bearer ${REDACTED}`);
  });

  it('keeps ordinary prose that mentions bearer without a credential', () => {
    expect(redact('the bearer of this note')).toBe('the bearer of this note');
  });

  it('does not mutate the input and keeps non-sensitive keys', () => {
    const input = { descricao: 'Parafuso', valor_unitario: 1.5, tokenizer: 'keep?' };
    const copy = JSON.parse(JSON.stringify(input)) as typeof input;
    const out = redact(input);
    expect(input).toEqual(copy);
    expect(out).toEqual({ descricao: 'Parafuso', valor_unitario: 1.5, tokenizer: 'keep?' });
  });

  it('handles cycles without throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    expect(() => redact(a)).not.toThrow();
  });

  it('ignores __proto__ keys (no prototype pollution through redaction)', () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as object;
    const out = redact(input) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.ok).toBe(1);
  });
});

describe('createRedactor', () => {
  it('scrubs known secret values embedded in strings', () => {
    const r = createRedactor(['SUPERSECRET123456', 'short']);
    const out = r({
      message: 'auth failed for SUPERSECRET123456 at x',
      list: ['SUPERSECRET123456'],
    });
    expect(JSON.stringify(out)).not.toContain('SUPERSECRET123456');
    expect(out).toEqual({ message: `auth failed for ${REDACTED} at x`, list: [REDACTED] });
  });

  it('ignores empty or very short secret values to avoid over-redaction', () => {
    const r = createRedactor(['', 'ab']);
    expect(r({ text: 'abc' })).toEqual({ text: 'abc' });
  });

  it('redacts plain strings', () => {
    const r = createRedactor(['TOPSECRETVALUE']);
    expect(r('x TOPSECRETVALUE y')).toBe(`x ${REDACTED} y`);
  });
});

describe('createRedactor with errors and dates', () => {
  it('keeps (scrubbed) error messages and stacks and preserves dates', () => {
    const scrub = createRedactor(['super-secret-value']);
    const out = scrub({
      err: new Error('failed with super-secret-value'),
      at: new Date('2026-01-01T00:00:00Z'),
    }) as { err: { message: string; stack: string }; at: Date };
    expect(out.err.message).toBe(`failed with ${REDACTED}`);
    expect(out.err.stack).not.toContain('super-secret-value');
    expect(out.at).toBeInstanceOf(Date);
    expect(out.at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('sensitive column names', () => {
  it('masks password-like columns case-insensitively, including Portuguese SENHA', () => {
    for (const name of [
      'SENHA',
      'senha',
      'Senha',
      'PASSWORD',
      'password',
      'PASSWD',
      'TOKEN',
      'SECRET',
    ])
      expect(isSensitiveColumn(name), name).toBe(true);
    // Embedded in a longer column name (ERP custom columns such as AD_SENHA_WEB).
    for (const name of [
      'AD_SENHA_WEB',
      'SENHAUSU',
      'USER_PASSWD',
      'API_TOKEN_ID',
      'CLIENT_SECRET_KEY',
    ])
      expect(isSensitiveColumn(name), name).toBe(true);
    // Everything the key redactor already treats as sensitive stays sensitive.
    for (const name of ['appkey', 'authorization', 'cookie', 'session', 'jsessionid'])
      expect(isSensitiveColumn(name), name).toBe(true);
  });

  it('keeps ordinary columns', () => {
    for (const name of ['CODPARC', 'NOMEPARC', 'EMAIL', 'DTALTER', 'VLRNOTA', 'ATIVO'])
      expect(isSensitiveColumn(name), name).toBe(false);
  });

  it('treats senha and passwd as sensitive keys in general redaction too', () => {
    expect(isSensitiveKey('SENHA')).toBe(true);
    expect(isSensitiveKey('passwd')).toBe(true);
    expect(redact({ SENHA: 'abc123', NOME: 'x' })).toEqual({ SENHA: REDACTED, NOME: 'x' });
  });
});

describe('redactSnapshot', () => {
  it('masks sensitive columns in every row and scrubs credentials in values', () => {
    const out = redactSnapshot([
      { CODUSU: 1, NOMEUSU: 'demo', SENHA: 'plain-1', PASSWORD: 'plain-2', Token: 't' },
      { CODUSU: 2, NOMEUSU: 'other', OBS: 'sent Bearer abc.def.ghi1 upstream' },
    ]);
    expect(out).toEqual({
      rows: [
        { CODUSU: 1, NOMEUSU: 'demo', SENHA: REDACTED, PASSWORD: REDACTED, Token: REDACTED },
        { CODUSU: 2, NOMEUSU: 'other', OBS: `sent Bearer ${REDACTED} upstream` },
      ],
      totalRows: 2,
      truncated: false,
      truncatedBytes: 0,
    });
    expect(JSON.stringify(out)).not.toContain('plain-');
  });

  it('caps the snapshot at 50 rows by default and records the truncation', () => {
    expect(SNAPSHOT_MAX_ROWS).toBe(50);
    const rows = Array.from({ length: 73 }, (_, i) => ({ ID: i }));
    const out = redactSnapshot(rows);
    expect(out.rows).toHaveLength(50);
    expect(out.rows[49]).toEqual({ ID: 49 });
    expect(out.totalRows).toBe(73);
    expect(out.truncated).toBe(true);
  });

  it('never raises the cap above 50 rows and does not mutate its input', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ ID: i, SENHA: 's' }));
    expect(redactSnapshot(rows, 10).rows).toHaveLength(10);
    expect(redactSnapshot(rows, 1000).rows).toHaveLength(50);
    expect(rows[0]).toEqual({ ID: 0, SENHA: 's' });
  });

  it('refuses rows that are not plain objects (no column names to check)', () => {
    const out = redactSnapshot([['secret-value', 1] as unknown as Record<string, unknown>]);
    expect(out.rows).toEqual([REDACTED]);
  });
});
