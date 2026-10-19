import { AppError } from '@dbx/shared';
import { readLimited, transportError, type TokenProvider } from './auth';
import { abortError } from './limiter';
import type { GatewayRequest, GatewayTransport, TransportResponse } from './types';

export interface GatewayTransportOptions {
  /** Gateway origin, e.g. `https://api.example.com` (validated by the caller). */
  baseUrl: string;
  tokens: TokenProvider;
  fetch: typeof fetch;
  /** Per-request timeout. */
  timeoutMs: number;
  maxResponseBytes: number;
}

const SERVICE_NAME = /^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/;

/** Builds the `service.sbr` URL. The service name is validated so it cannot alter the path. */
export function serviceUrl(baseUrl: string, req: Pick<GatewayRequest, 'module' | 'serviceName'>) {
  if (!SERVICE_NAME.test(req.serviceName)) throw new Error('Invalid gateway service name');
  if (req.module !== 'mge' && req.module !== 'mgecom') throw new Error('Invalid gateway module');
  const url = new URL(`gateway/v1/${req.module}/service.sbr`, withSlash(baseUrl));
  url.searchParams.set('serviceName', req.serviceName);
  url.searchParams.set('outputType', 'json');
  return url;
}

/**
 * One HTTP exchange with the gateway: bearer token, no redirects, a per-request timeout and a cap
 * on the response size. Failures to obtain the token carry `details.stage = 'auth'`, so callers
 * know the request itself was never sent.
 */
export function createGatewayTransport(opts: GatewayTransportOptions): GatewayTransport {
  return {
    async send(req, signal) {
      const url = serviceUrl(opts.baseUrl, req);
      let token: string;
      try {
        token = await opts.tokens.getToken(signal);
      } catch (err) {
        if (signal?.aborted) throw abortError(signal);
        const e = err instanceof AppError ? err : transportError(err);
        throw new AppError(e.code, e.message, { ...e.details, stage: 'auth' });
      }

      const timeout = AbortSignal.timeout(opts.timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const res = await opts.fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json; charset=utf-8',
            accept: 'application/json',
          },
          body: JSON.stringify({ serviceName: req.serviceName, requestBody: req.requestBody }),
          redirect: 'error',
          signal: combined,
        });
        const text = await readLimited(res, opts.maxResponseBytes);
        const out: TransportResponse = { httpStatus: res.status, body: parseJson(text) };
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        if (retryAfter !== undefined) out.retryAfterSeconds = retryAfter;
        return out;
      } catch (err) {
        if (signal?.aborted) throw abortError(signal);
        throw transportError(err);
      }
    },
  };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `Retry-After` as seconds (delta-seconds or HTTP date), capped to five minutes. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+$/.test(trimmed)
    ? Number(trimmed)
    : Math.ceil((Date.parse(trimmed) - now) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds, 300);
}

function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}
