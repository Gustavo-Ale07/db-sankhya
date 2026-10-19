import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isAppError } from '@dbx/shared';
import type { TokenProvider } from './auth';
import { createGatewayTransport, parseRetryAfter } from './transport';

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let baseUrl: string;
let handler: Handler = (_req, res) => res.end();

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const tokens: TokenProvider = {
  getToken: () => Promise.resolve('test-access-token'),
  invalidate: () => {},
};

function transport(opts: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  return createGatewayTransport({
    baseUrl,
    tokens,
    fetch: globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? 2_000,
    maxResponseBytes: opts.maxResponseBytes ?? 100_000,
  });
}

const request = {
  module: 'mge' as const,
  serviceName: 'DbExplorerSP.executeQuery',
  requestBody: { sql: 'SELECT 1' },
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  if (!isAppError(e)) throw new Error(`expected an AppError, got ${String(e)}`);
  return e.code;
}

describe('gateway transport (HTTP)', () => {
  it('posts the envelope with the bearer token and parses the JSON answer', async () => {
    let seen: { url?: string; auth?: string; type?: string; body?: unknown } = {};
    handler = (req, res, body) => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        type: req.headers['content-type'],
        body: JSON.parse(body) as unknown,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: '1', responseBody: { rows: [] } }));
    };
    const out = await transport().send(request);
    expect(out).toEqual({ httpStatus: 200, body: { status: '1', responseBody: { rows: [] } } });
    expect(seen.url).toBe(
      '/gateway/v1/mge/service.sbr?serviceName=DbExplorerSP.executeQuery&outputType=json',
    );
    expect(seen.auth).toBe('Bearer test-access-token');
    expect(seen.type).toMatch(/^application\/json/);
    expect(seen.body).toEqual({
      serviceName: 'DbExplorerSP.executeQuery',
      requestBody: { sql: 'SELECT 1' },
    });
  });

  it('does not follow redirects', async () => {
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:1/elsewhere');
      res.end();
    };
    expect(await codeOf(transport().send(request))).toBe('SANKHYA_UNAVAILABLE');
  });

  it('rejects oversized responses', async () => {
    handler = (_req, res) => res.end(JSON.stringify({ status: '1', pad: 'x'.repeat(5_000) }));
    expect(await codeOf(transport({ maxResponseBytes: 1_000 }).send(request))).toBe(
      'SANKHYA_BAD_RESPONSE',
    );
  });

  it('times out slow answers', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 1_000).unref();
    };
    expect(await codeOf(transport({ timeoutMs: 100 }).send(request))).toBe('SANKHYA_TIMEOUT');
  });

  it('a caller abort is reported as a cancellation', async () => {
    handler = (_req, res) => {
      setTimeout(() => res.end('{}'), 1_000).unref();
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    expect(await codeOf(transport().send(request, controller.signal))).toBe('QUERY_CANCELLED');
  });

  it('keeps the HTTP status and Retry-After, and tolerates non-JSON bodies', async () => {
    handler = (_req, res) => {
      res.statusCode = 429;
      res.setHeader('retry-after', '7');
      res.end('slow down');
    };
    expect(await transport().send(request)).toEqual({
      httpStatus: 429,
      body: undefined,
      retryAfterSeconds: 7,
    });
  });
});

describe('parseRetryAfter', () => {
  it('accepts seconds and HTTP dates, capped at five minutes', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30);
    expect(parseRetryAfter('99999', now)).toBe(300);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
