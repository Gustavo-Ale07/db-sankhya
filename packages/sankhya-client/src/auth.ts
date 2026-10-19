import { AppError } from '@dbx/shared';
import { abortError } from './limiter';

export interface TokenProviderOptions {
  /** Full URL of the gateway authentication endpoint. */
  authUrl: string;
  clientId: string;
  clientSecret: string;
  /** Per-installation token the gateway expects in the `X-Token` header. */
  xToken: string;
  fetch: typeof fetch;
  timeoutMs: number;
  /** Seconds before `expires_in` at which a cached token is considered stale. */
  earlyRefreshSeconds?: number;
  now?: () => number;
}

export interface TokenProvider {
  getToken(signal?: AbortSignal): Promise<string>;
  /** Drops the cached token, e.g. after the gateway rejected it. */
  invalidate(): void;
}

const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;

/**
 * OAuth2 client_credentials against the Sankhya gateway. The token is cached until shortly before
 * it expires and fetched once for any number of concurrent callers. Credentials only ever leave in
 * the request to `authUrl`; errors carry the HTTP status, never the response body.
 */
export function createTokenProvider(opts: TokenProviderOptions): TokenProvider {
  const now = opts.now ?? Date.now;
  const earlyMs = (opts.earlyRefreshSeconds ?? 30) * 1000;
  let cached: { token: string; staleAt: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const fetchToken = async (): Promise<string> => {
    const body = new URLSearchParams({
      client_id: opts.clientId,
      client_secret: opts.clientSecret,
      grant_type: 'client_credentials',
    });
    let res: Response;
    let text: string;
    try {
      res = await opts.fetch(opts.authUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'x-token': opts.xToken,
        },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      text = await readLimited(res, MAX_AUTH_RESPONSE_BYTES);
    } catch (err) {
      throw transportError(err);
    }
    if (!res.ok) throw statusError(res.status);
    const token = parseToken(text);
    const expiresInMs = token.expiresIn * 1000;
    cached = { token: token.accessToken, staleAt: now() + Math.max(0, expiresInMs - earlyMs) };
    return token.accessToken;
  };

  return {
    getToken(signal) {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (cached && now() < cached.staleAt) return Promise.resolve(cached.token);
      inFlight ??= fetchToken().finally(() => {
        inFlight = undefined;
      });
      return signal ? raceAbort(inFlight, signal) : inFlight;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

function parseToken(text: string): { accessToken: string; expiresIn: number } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw badResponse();
  }
  if (!json || typeof json !== 'object') throw badResponse();
  const { access_token: accessToken, expires_in: expiresIn } = json as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken.length === 0) throw badResponse();
  const seconds = typeof expiresIn === 'string' ? Number(expiresIn) : expiresIn;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) throw badResponse();
  return { accessToken, expiresIn: seconds };
}

function badResponse(): AppError {
  return new AppError(
    'SANKHYA_BAD_RESPONSE',
    'The Sankhya authentication endpoint returned an unexpected response.',
  );
}

function statusError(status: number): AppError {
  if (status === 401 || status === 403 || status === 400) {
    return new AppError(
      'SANKHYA_AUTH_ERROR',
      `The Sankhya gateway rejected the connection credentials (HTTP ${status}).`,
      { httpStatus: status },
    );
  }
  if (status === 429) {
    return new AppError('SANKHYA_RATE_LIMITED', 'The Sankhya gateway is rate limiting requests.', {
      httpStatus: status,
    });
  }
  if (status === 504) {
    return new AppError('SANKHYA_TIMEOUT', 'The Sankhya gateway timed out.', {
      httpStatus: status,
    });
  }
  return new AppError(
    'SANKHYA_UNAVAILABLE',
    `The Sankhya authentication endpoint failed (HTTP ${status}).`,
    { httpStatus: status },
  );
}

/** Network-level failure. The original error is dropped: its text may echo request data. */
export function transportError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return new AppError('SANKHYA_TIMEOUT', 'The Sankhya gateway did not answer in time.');
  }
  return new AppError('SANKHYA_UNAVAILABLE', 'Could not reach the Sankhya gateway.');
}

/** Reads the body as text, aborting once it exceeds `maxBytes`. */
export async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function tooLarge(): AppError {
  return new AppError('SANKHYA_BAD_RESPONSE', 'The Sankhya gateway response was too large.');
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
}
