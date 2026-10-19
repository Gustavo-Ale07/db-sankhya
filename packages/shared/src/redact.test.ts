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
  redactSnapshotPair,
  utf8ByteLength,
} from './redact';

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('surrogate-safe clipping', () => {
  it('never leaves a lone surrogate when clipping splits an astral character', () => {
    const value = `${'a'.repeat(1999)}😀tail`;
    const out = redactSnapshot([{ OBS: value }]);
    const obs = (out.rows[0] as { OBS: string }).OBS;
    expect(LONE_SURROGATE.test(obs)).toBe(false);
    expect(obs).toBe(`${'a'.repeat(1999)}…`);
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    expect(JSON.stringify(out)).not.toMatch(/\\ud[89a-f]/i);
  });

  it('keeps a whole astral character that fits and replaces lone surrogates from the input', () => {
    const fits = `${'a'.repeat(1998)}😀`;
    expect((redactSnapshot([{ T: fits }]).rows[0] as { T: string }).T).toBe(fits);
    const broken = `x\uD800y\uDC00z`;
    const t = (redactSnapshot([{ T: broken }]).rows[0] as { T: string }).T;
    expect(t).toBe('x�y�z');
  });

  it('clips and fixes surrogates in redactBroad when asked to clip', () => {
    const out = redactBroad(
      { a: `${'a'.repeat(1999)}😀`, nested: ['b'.repeat(2500)] },
      {
        clipStrings: true,
      },
    ) as { a: string; nested: string[] };
    expect(out.a).toBe(`${'a'.repeat(1999)}…`);
    expect(out.nested[0]).toBe(`${'b'.repeat(2000)}…`);
    // Without the option strings are untouched.
    expect((redactBroad({ a: 'b'.repeat(2500) }) as { a: string }).a).toHaveLength(2500);
  });
});

describe('jsonb-safe audit strings and keys', () => {
  it('strips NUL from string values, with and without clipping', () => {
    expect(redactBroad({ OBS: 'a\u0000b\u0000' })).toEqual({ OBS: 'ab' });
    expect(redactBroad(['x\u0000y'], { clipStrings: true })).toEqual(['xy']);
    const snap = redactSnapshot([{ OBS: '\u0000start' }]);
    expect(snap.rows).toEqual([{ OBS: 'start' }]);
  });

  it('strips NUL from object keys and replaces lone surrogates in keys, at any depth', () => {
    const out = redactBroad({
      'CO\u0000DPARC': 1,
      nested: { [`bad\uD800key`]: 'v', list: [{ [`x\uDC00\u0000y`]: 2 }] },
    });
    expect(out).toEqual({
      CODPARC: 1,
      nested: { 'bad�key': 'v', list: [{ 'x�y': 2 }] },
    });
    expect(JSON.stringify(out)).not.toMatch(/\\u0000|\\ud[89a-f]/i);
  });

  it('masks a sensitive key whose name is split by NUL', () => {
    expect(redactBroad({ 'AD_SEN\u0000HA': 'v1' })).toEqual({ AD_SENHA: REDACTED });
    expect(redactSnapshot([{ 'pass\u0000word': 'v2' }]).rows).toEqual([{ password: REDACTED }]);
  });

  it('normalizes before scrubbing, so NUL cannot hide a credential that the strip rebuilds', () => {
    const out = JSON.stringify([
      redactBroad({ msg: 'Bear\u0000er abc.DEF123' }),
      redactBroad({ msg: 'pass\u0000word=hunter2X' }, { clipStrings: true }),
      redactSnapshot([{ OBS: 'Bearer\u0000 abc.DEF123' }]),
    ]);
    expect(out).not.toContain('abc.DEF123');
    expect(out).not.toContain('hunter2X');
    expect(out).not.toContain('\\u0000');
    expect((redactBroad({ msg: 'pass\u0000word=hunter2X' }) as { msg: string }).msg).toBe(
      `password=${REDACTED}`,
    );
  });

  it('redacts sensitive key=value pairs inside free text', () => {
    expect(redact('login failed: password=hunter2X&user=a')).toBe(
      `login failed: password=${REDACTED}&user=a`,
    );
    expect(redact('{"senha": "abc123"}')).toBe(`{"senha": "${REDACTED}"}`);
    expect(redact('client_secret:xyz789 ok')).toBe(`client_secret:${REDACTED} ok`);
    expect(redact('the token expired')).toBe('the token expired');
  });

  it('redacts single- and double-quoted keys and values, including values with spaces', () => {
    expect(redact(`password='hunter2'`)).toBe(`password='${REDACTED}'`);
    expect(redact(`{'senha': 'abc'}`)).toBe(`{'senha': '${REDACTED}'}`);
    expect(redact(`password="my long pass"`)).toBe(`password="${REDACTED}"`);
    expect(redact(`"token" = 'a b c' rest`)).toBe(`"token" = '${REDACTED}' rest`);
    const out = redact(`password="my long pass" and {'senha': 'abc'}`) as string;
    for (const part of ['my', 'long', 'pass"', `'abc'`]) expect(out).not.toContain(part);
  });

  it('matches the whole compound key name', () => {
    for (const key of ['db_user_password', 'secret_key', 'password_hash', 'token_value']) {
      expect(redact(`${key}=abc`)).toBe(`${key}=${REDACTED}`);
      expect(redact(`x ${key.toUpperCase()}: "abc" y`)).toBe(
        `x ${key.toUpperCase()}: "${REDACTED}" y`,
      );
    }
    expect(redact('API-KEY=abc123&x=1')).toBe(`API-KEY=${REDACTED}&x=1`);
    // A sensitive pair inside the quoted value of another key is still found.
    expect(redact(`q="select 1" password=abc`)).toBe(`q="select 1" password=${REDACTED}`);
  });

  it('keeps only status words after "key: " and redacts everything else', () => {
    expect(redact('token: expired')).toBe('token: expired');
    expect(redact('password: abcde')).toBe(`password: ${REDACTED}`);
    expect(redact('password: must be 8 chars')).toBe(`password: ${REDACTED} be 8 chars`);
    expect(redact('secret_key=abc')).toBe(`secret_key=${REDACTED}`);
    expect(redact('password: hunter2')).toBe(`password: ${REDACTED}`);
    expect(redact('password: Hunter')).toBe(`password: ${REDACTED}`);
    expect(redact('password: sunshine')).toBe(`password: ${REDACTED}`);
    // `=` is never prose, whatever the value looks like.
    expect(redact('password=abc')).toBe(`password=${REDACTED}`);
  });

  it('redacts every value of a cookie header and session-like keys in free text', () => {
    const cases: Array<[string, string[]]> = [
      ['Cookie: JSESSIONID=abc123; mgesession=xyz', ['abc123', 'xyz']],
      ['cookie=a=b; session=c', ['=b', '=c']],
      ['Set-Cookie: sid=abc; Path=/', ['abc', '=/']],
      ['Cookie: theme=dark; lang=pt', ['dark', 'pt']],
      [
        'sid=s1v4l&pwd=p4ss&appkey=k3y&app_key=k4y&PHPSESSID=q9',
        ['s1v4l', 'p4ss', 'k3y', 'k4y', 'q9'],
      ],
      ['"session": "opaque", jsessionid=j1, mgesession=m1', ['opaque', 'j1', 'm1']],
    ];
    for (const [input, secrets] of cases) {
      const out = redact(input) as string;
      for (const secret of secrets) expect(out, input).not.toContain(secret);
      expect(out).toContain(REDACTED);
    }
    // `sid` and `pwd` count only as a whole name segment.
    expect(redact('consider=yes&inside=1')).toBe('consider=yes&inside=1');
  });

  it('redacts authorization schemes and lowercase bearer credentials', () => {
    expect(redact('Authorization: Basic dXNlcjpwYXNz')).toBe(`Authorization: Basic ${REDACTED}`);
    expect(redact('authorization: Bearer xyz')).toBe(`authorization: Bearer ${REDACTED}`);
    expect(redact('Bearer abcdef')).toBe(`Bearer ${REDACTED}`);
    expect(redact('Proxy-Authorization: Digest u=1')).not.toContain('u=1');
    expect(redact('{"Authorization": "Basic dXNlcjpwYXNz"}')).toBe(
      `{"Authorization": "${REDACTED}"}`,
    );
    expect(redact('authorization=abc123')).toBe(`authorization=${REDACTED}`);
    // Status words stay readable after bearer and after `authorization: `.
    expect(redact('bearer expired')).toBe('bearer expired');
    expect(redact('authorization: missing')).toBe('authorization: missing');
  });

  it('redacts backslash-escaped JSON', () => {
    expect(redact('{\\"password\\":\\"hunter2\\"}')).toBe(`{\\"password\\":\\"${REDACTED}\\"}`);
    expect(redact("{\\'token\\': \\'a b\\'}")).toBe(`{\\'token\\': \\'${REDACTED}\\'}`);
    const out = redact('body={\\"user\\":\\"a\\",\\"client_secret\\":\\"s3cr3t x\\"}') as string;
    expect(out).not.toMatch(/s3cr3t| x\\/);
  });

  it('allows exactly one space before a kept status word and never keeps part of a curly-quoted value', () => {
    expect(redact('password:\texpired')).toBe(`password:\t${REDACTED}`);
    expect(redact('password:  expired')).toBe(`password:  ${REDACTED}`);
    expect(redact('password: expired')).toBe('password: expired');
    expect(redact('password=“fancy quoted”')).toBe(`password=“${REDACTED}”`);
    expect(redact('password=‘fancy quoted’')).toBe(`password=‘${REDACTED}’`);
    const open = redact('password=“fancy unterminated') as string;
    expect(open).not.toContain('fancy');
  });

  it('is idempotent on already redacted pairs', () => {
    const once = redact(`password="x y" token='z' secret=w1`) as string;
    expect(redact(once)).toBe(once);
  });

  it('scrubs key=value pairs in linear time on adversarial input', () => {
    const N = 1_000_000;
    const inputs = [
      'password'.repeat(N / 8),
      'a-'.repeat(N / 2),
      'x_'.repeat(N / 2),
      `password="${'a'.repeat(N)}`,
      `token:${' '.repeat(N)}`,
      `token${' '.repeat(N)}x`,
      `'token`.repeat(N / 6),
      'password: '.repeat(N / 10),
      'secret='.repeat(N / 7),
      `${'p'.repeat(N)}password`,
      'token=“'.repeat(N / 7),
      `Cookie: a=b${'; c=d'.repeat(N / 5)}`,
      'Authorization: '.repeat(N / 15),
      `authorization: Basic${' '.repeat(N)}`,
      '{\\"password\\":\\"'.repeat(N / 16),
      `${'x_'.repeat(N / 2)}sid`,
    ];
    for (const input of inputs) {
      const start = Date.now();
      redact(input);
      expect(Date.now() - start, input.slice(0, 20)).toBeLessThan(1000);
    }
  });

  it('leaves keys of the log redactor untouched', () => {
    expect(Object.keys(redact({ 'a\u0000b': 1 }) as object)).toEqual(['a\u0000b']);
  });
});

describe('redactSnapshotPair', () => {
  const big = () =>
    Array.from({ length: 50 }, (_, i) => ({
      ID: i,
      ...Object.fromEntries(Array.from({ length: 10 }, (_, c) => [`C${c}`, 'x'.repeat(2000)])),
    }));

  it('shares one 256 KB budget across before and after', () => {
    const out = redactSnapshotPair({ before: big(), after: big() });
    // The pair object adds only the {"before":,"after":} keys on top of the budget.
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES + 32);
    expect(out.before?.rows.length).toBeGreaterThan(0);
    expect(out.before?.truncated).toBe(true);
    expect(out.after?.truncated).toBe(true);
    expect(out.after?.truncatedBytes).toBeGreaterThan(0);
  });

  it('gives after whatever before left over and omits absent sides', () => {
    const small = redactSnapshotPair({ before: [{ ID: 1 }], after: big() });
    expect(small.before).toMatchObject({ rows: [{ ID: 1 }], truncated: false });
    expect(small.after?.rows.length).toBeGreaterThan(0);
    expect(utf8ByteLength(JSON.stringify(small))).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES + 32);
    expect(redactSnapshotPair({ after: [{ ID: 2 }] })).toEqual({
      after: { rows: [{ ID: 2 }], totalRows: 1, truncated: false, truncatedBytes: 0 },
    });
  });
});

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

  it('keeps only status words after bearer', () => {
    expect(redact('the bearer expired')).toBe('the bearer expired');
    // Any other word may be a credential: ordinary prose is redacted too (fail closed).
    expect(redact('the bearer of this note')).toBe(`the bearer ${REDACTED} this note`);
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
