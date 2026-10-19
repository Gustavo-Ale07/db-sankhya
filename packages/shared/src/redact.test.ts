import { describe, expect, it } from 'vitest';
import { REDACTED, createRedactor, redact } from './redact';

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
