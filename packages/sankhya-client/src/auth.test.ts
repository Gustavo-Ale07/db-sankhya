import { describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import { createTokenProvider, type TokenProviderOptions } from './auth';

const CLIENT_SECRET = 'test-client-secret-value-0001';
const X_TOKEN = 'test-x-token-value-0002';

interface Recorded {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (n: number) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const fetch = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(respond(calls.length));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const tokenResponse = (n: number, expiresIn = 300) =>
  new Response(
    JSON.stringify({ access_token: `access-${n}`, token_type: 'Bearer', expires_in: expiresIn }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

function provider(fetch: typeof globalThis.fetch, extra: Partial<TokenProviderOptions> = {}) {
  return createTokenProvider({
    authUrl: 'https://gateway.test/authenticate',
    clientId: 'test-client-id',
    clientSecret: CLIENT_SECRET,
    xToken: X_TOKEN,
    fetch,
    timeoutMs: 5_000,
    ...extra,
  });
}

async function errorOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e,
  );
}

describe('createTokenProvider', () => {
  it('posts form-encoded client_credentials with X-Token', async () => {
    const f = fakeFetch((n) => tokenResponse(n));
    await expect(provider(f.fetch).getToken()).resolves.toBe('access-1');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://gateway.test/authenticate');
    expect(init.method).toBe('POST');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(headers.get('x-token')).toBe(X_TOKEN);
    const body = Object.fromEntries(new URLSearchParams(String(init.body)));
    expect(body).toEqual({
      client_id: 'test-client-id',
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    });
  });

  it('caches until expires_in minus early refresh', async () => {
    let t = 0;
    const f = fakeFetch((n) => tokenResponse(n, 300));
    const p = provider(f.fetch, { now: () => t });
    await p.getToken();
    t = 269_000;
    await expect(p.getToken()).resolves.toBe('access-1');
    expect(f.calls).toHaveLength(1);
    t = 271_000;
    await expect(p.getToken()).resolves.toBe('access-2');
    expect(f.calls).toHaveLength(2);
  });

  it('single-flight: concurrent callers share one request', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const f = fakeFetch(async (n) => {
      await gate;
      return tokenResponse(n);
    });
    const p = provider(f.fetch);
    const all = Promise.all(Array.from({ length: 5 }, () => p.getToken()));
    release();
    expect(await all).toEqual(Array(5).fill('access-1'));
    expect(f.calls).toHaveLength(1);
  });

  it('invalidate forces re-auth', async () => {
    const f = fakeFetch((n) => tokenResponse(n));
    const p = provider(f.fetch);
    await p.getToken();
    p.invalidate();
    await expect(p.getToken()).resolves.toBe('access-2');
  });

  it('a failed request clears the in-flight promise so the next call retries', async () => {
    const f = fakeFetch((n) =>
      n === 1 ? new Response('busy', { status: 503 }) : tokenResponse(n),
    );
    const p = provider(f.fetch);
    await expect(p.getToken()).rejects.toThrow();
    await expect(p.getToken()).resolves.toBe('access-2');
  });

  it('401 maps to SANKHYA_AUTH_ERROR and the message contains no secret', async () => {
    const f = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ error: 'invalid_client', echo: `${CLIENT_SECRET} ${X_TOKEN}` }),
          { status: 401 },
        ),
    );
    const err = await errorOf(provider(f.fetch).getToken());
    expect(isAppError(err) && err.code).toBe('SANKHYA_AUTH_ERROR');
    const text = `${(err as Error).message} ${JSON.stringify(err)} ${String((err as Error).stack)}`;
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(X_TOKEN);
  });

  it('maps 429 and 5xx to retryable gateway codes', async () => {
    const rate = await errorOf(
      provider(fakeFetch(() => new Response('', { status: 429 })).fetch).getToken(),
    );
    expect(isAppError(rate) && rate.code).toBe('SANKHYA_RATE_LIMITED');
    const down = await errorOf(
      provider(fakeFetch(() => new Response('', { status: 502 })).fetch).getToken(),
    );
    expect(isAppError(down) && down.code).toBe('SANKHYA_UNAVAILABLE');
  });

  it('redirects are refused', async () => {
    const f = fakeFetch((n) => tokenResponse(n));
    await provider(f.fetch).getToken();
    expect(f.calls[0]!.init.redirect).toBe('error');
  });

  it('malformed body maps to SANKHYA_BAD_RESPONSE', async () => {
    for (const body of [
      'not json',
      '{"token_type":"Bearer"}',
      '{"access_token":"","expires_in":60}',
    ]) {
      const err = await errorOf(
        provider(fakeFetch(() => new Response(body, { status: 200 })).fetch).getToken(),
      );
      expect(isAppError(err) && err.code).toBe('SANKHYA_BAD_RESPONSE');
    }
  });

  it('network failures map to SANKHYA_UNAVAILABLE without leaking credentials', async () => {
    const fetch = (() =>
      Promise.reject(new TypeError(`connect failed ${CLIENT_SECRET}`))) as typeof globalThis.fetch;
    const err = await errorOf(provider(fetch).getToken());
    expect(isAppError(err) && err.code).toBe('SANKHYA_UNAVAILABLE');
    expect(JSON.stringify(err) + (err as Error).message).not.toContain(CLIENT_SECRET);
  });

  it('a timeout maps to SANKHYA_TIMEOUT', async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      })) as typeof globalThis.fetch;
    const err = await errorOf(provider(fetch, { timeoutMs: 20 }).getToken());
    expect(isAppError(err) && err.code).toBe('SANKHYA_TIMEOUT');
  });
});
