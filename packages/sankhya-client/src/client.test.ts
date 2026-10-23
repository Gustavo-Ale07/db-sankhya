import { describe, expect, it, vi } from 'vitest';
import { AppError, isAppError } from '@dbx/shared';
import type { TokenProvider } from './auth';
import { CircuitBreaker } from './circuit';
import { SankhyaClient } from './client';
import { CallRateLimiter, ConcurrencyLimiter } from './limiter';
import { createGatewayTransport } from './transport';
import type { CallTrace, GatewayRequest, GatewayTransport, TransportResponse } from './types';

const ok = (responseBody: unknown, extra: Record<string, unknown> = {}): TransportResponse => ({
  httpStatus: 200,
  body: { serviceName: 'X.y', status: '1', responseBody, ...extra },
});
const status = (httpStatus: number, body?: unknown): TransportResponse => ({ httpStatus, body });

type Responder = (req: GatewayRequest, n: number) => TransportResponse | Promise<TransportResponse>;

function setup(respond: Responder, opts: { threshold?: number; maxRetries?: number } = {}) {
  const requests: GatewayRequest[] = [];
  const transport: GatewayTransport = {
    send: vi.fn((req: GatewayRequest) => {
      requests.push(req);
      return Promise.resolve(respond(req, requests.length));
    }),
  };
  const tokens: TokenProvider = {
    getToken: vi.fn(() => Promise.resolve('access-token-value')),
    invalidate: vi.fn(),
  };
  const traces: CallTrace[] = [];
  const client = new SankhyaClient({
    transport,
    tokens,
    breaker: new CircuitBreaker({ failureThreshold: opts.threshold ?? 50, resetAfterMs: 60_000 }),
    rate: new CallRateLimiter(6_000),
    concurrency: new ConcurrencyLimiter(4),
    retry: { maxRetries: opts.maxRetries ?? 2, baseMs: 1 },
    onTrace: (t) => traces.push(t),
    sleep: () => Promise.resolve(),
  });
  return { client, transport, tokens, requests, traces };
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => new Error('expected a rejection'),
    (err: unknown) => err,
  );
  if (!isAppError(e)) throw e;
  return e;
}

describe('SankhyaClient', () => {
  it('executeQuery maps fieldsMetadata and rows', async () => {
    const { client, requests } = setup(() =>
      ok({
        fieldsMetadata: [
          { name: 'CODPARC', userType: 'I' },
          { name: 'NOMEPARC', userType: 'S' },
        ],
        rows: [
          [1, 'Alfa'],
          [2, 'Beta'],
        ],
        burstLimit: false,
      }),
    );
    const out = await client.executeQuery('SELECT CODPARC, NOMEPARC FROM TGFPAR');
    expect(out).toEqual({
      columns: ['CODPARC', 'NOMEPARC'],
      rows: [
        [1, 'Alfa'],
        [2, 'Beta'],
      ],
      truncated: false,
    });
    expect(requests[0]).toEqual({
      module: 'mge',
      serviceName: 'DbExplorerSP.executeQuery',
      requestBody: { sql: 'SELECT CODPARC, NOMEPARC FROM TGFPAR' },
    });
  });

  it('executeQuery rejects a response without the expected shape', async () => {
    const { client } = setup(() => ok({ rows: 'nope' }));
    expect((await errorOf(client.executeQuery('SELECT 1'))).code).toBe('SANKHYA_BAD_RESPONSE');
  });

  it('executeQuery calls are serialised', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = setup(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok({ fieldsMetadata: [], rows: [] });
    });
    await Promise.all([client.executeQuery('SELECT 1'), client.executeQuery('SELECT 2')]);
    expect(maxInFlight).toBe(1);
  });

  it('loadRecords builds the dataSet and maps f0..fn values', async () => {
    const { client, requests } = setup(() =>
      ok({
        entities: {
          hasMoreResult: 'true',
          metadata: { fields: { field: [{ name: 'CODPARC' }, { name: 'NOMEPARC' }] } },
          entity: { f0: { $: '7' }, f1: { $: 'Gama' } },
        },
      }),
    );
    const out = await client.loadRecords({
      rootEntity: 'Parceiro',
      fields: ['CODPARC', 'NOMEPARC'],
      criteria: { expression: 'this.CODPARC = ?', parameters: [{ value: 7, type: 'I' }] },
    });
    expect(out).toEqual({ records: [{ CODPARC: '7', NOMEPARC: 'Gama' }], hasMore: true });
    expect(requests[0]!.requestBody).toEqual({
      dataSet: {
        rootEntity: 'Parceiro',
        includePresentationFields: 'N',
        offsetPage: '0',
        entity: { fieldset: { list: 'CODPARC,NOMEPARC' } },
        criteria: { expression: { $: 'this.CODPARC = ?' }, parameter: [{ $: '7', type: 'I' }] },
      },
    });
  });

  it('reads re-authenticate once on a token rejection', async () => {
    const { client, tokens, transport } = setup((_req, n) =>
      n === 1
        ? status(403, { error: { code: 'GTW3403', message: 'expired' } })
        : ok({ fieldsMetadata: [], rows: [] }),
    );
    await client.executeQuery('SELECT 1');
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('a second token rejection is not retried again', async () => {
    const { client, tokens, transport } = setup(() => status(401));
    expect((await errorOf(client.executeQuery('SELECT 1'))).code).toBe('SANKHYA_AUTH_ERROR');
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('reads retry transient failures up to maxRetries', async () => {
    const { client, transport } = setup((_r, n) =>
      n < 3 ? status(503) : ok({ fieldsMetadata: [], rows: [] }),
    );
    await client.executeQuery('SELECT 1');
    expect(transport.send).toHaveBeenCalledTimes(3);
  });

  it('save is never retried: a 503 is an unknown outcome', async () => {
    const { client, transport } = setup(() => status(503));
    const err = await errorOf(
      client.save({
        entityName: 'Parceiro',
        fields: ['NOMEPARC'],
        records: [{ values: { NOMEPARC: 'x' } }],
      }),
    );
    expect(err.code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('save: a network failure after sending is an unknown outcome', async () => {
    const { client, transport } = setup(() => {
      throw new AppError('SANKHYA_TIMEOUT', 'timed out');
    });
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('save: a business error is reported as such and sent once', async () => {
    const { client, transport } = setup(() =>
      status(200, { status: '0', statusMessage: 'Campo obrigatório' }),
    );
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('SANKHYA_API_ERROR');
    expect(err.message).toContain('Campo obrigatório');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('save: an ambiguous status is an unknown outcome', async () => {
    const { client } = setup(() => status(200, { status: '2', statusMessage: 'aviso' }));
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('WRITE_OUTCOME_UNKNOWN');
  });

  it('save: rate limiting is reported as rate limiting, not as an unknown outcome', async () => {
    const { client, transport } = setup(() => status(429));
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('SANKHYA_RATE_LIMITED');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('save: a failed token request is a definite failure, not an unknown outcome', async () => {
    const { client } = setup(() => {
      throw new AppError('SANKHYA_AUTH_ERROR', 'bad credentials', { stage: 'auth' });
    });
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('SANKHYA_AUTH_ERROR');
  });

  it('save: a token rejection at the gateway is re-authenticated and sent again', async () => {
    const { client, tokens, transport } = setup((_req, n) =>
      n === 1 ? status(401) : ok({ result: [] }),
    );
    await client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] });
    expect(tokens.invalidate).toHaveBeenCalledTimes(1);
    expect(transport.send).toHaveBeenCalledTimes(2);
  });

  it('save: "não autorizado" inside an HTTP 200 envelope is never replayed', async () => {
    const { client, tokens, transport } = setup(() =>
      status(200, { status: '0', statusMessage: 'Não autorizado.' }),
    );
    const err = await errorOf(
      client.save({ entityName: 'Parceiro', fields: ['A'], records: [{ values: { A: 1 } }] }),
    );
    expect(err.code).toBe('SANKHYA_AUTH_ERROR');
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(tokens.invalidate).not.toHaveBeenCalled();
  });

  it('save maps field names to index-keyed values', async () => {
    const { client, requests } = setup(() => ok({ result: [['1', '2']] }, { transactionId: 'TX' }));
    const out = await client.save({
      entityName: 'Exemplo',
      fields: ['A', 'B'],
      records: [{ pk: { ID: 5 }, values: { B: 2, A: 1 } }],
    });
    expect(requests[0]).toEqual({
      module: 'mge',
      serviceName: 'DatasetSP.save',
      requestBody: {
        entityName: 'Exemplo',
        standAlone: false,
        fields: ['A', 'B'],
        records: [{ pk: { ID: 5 }, values: { '0': 1, '1': 2 } }],
      },
    });
    expect(out).toEqual({ results: [['1', '2']], transactionId: 'TX' });
  });

  it('save refuses values for fields outside the field list', async () => {
    const { client, transport } = setup(() => ok({}));
    await expect(
      client.save({ entityName: 'E', fields: ['A'], records: [{ values: { Z: 1 } }] }),
    ).rejects.toThrow(/not in the save field list/);
    expect(transport.send).not.toHaveBeenCalled();
  });

  it('executeJava sends the DBScript action envelope and returns the raw status', async () => {
    const { client, requests } = setup(() =>
      ok({ feedback: 'ok' }, { transactionId: 'TXE', status: '1' }),
    );
    const out = await client.executeJava({
      actionId: '98',
      entityName: 'AD_MANIPULADADOS',
      pk: { ID: 999 },
    });
    expect(requests[0]).toEqual({
      module: 'mge',
      serviceName: 'ActionButtonsSP.executeJava',
      requestBody: {
        javaCall: {
          actionID: '98',
          entityName: 'AD_MANIPULADADOS',
          refreshType: 'NONE',
          rows: { row: [{ field: [{ fieldName: 'ID', $: '999' }] }] },
        },
      },
    });
    expect(out.status).toBe('1');
    expect(out.transactionId).toBe('TXE');
    expect(out.responseBody).toEqual({ feedback: 'ok' });
  });

  it('executeJava honours the module override', async () => {
    const { client, requests } = setup(() => ok({}));
    await client.executeJava({ module: 'mgecom', actionId: '5', entityName: 'E', pk: { ID: 1 } });
    expect(requests[0]?.module).toBe('mgecom');
  });

  it('executeJava is never retried on an ambiguous outcome (sent exactly once)', async () => {
    // A 5xx is retryable for idempotent calls; a server-side action is not idempotent.
    const { client, requests } = setup(() => status(503));
    const err = await errorOf(
      client.executeJava({ actionId: '98', entityName: 'AD_MANIPULADADOS', pk: { ID: 1 } }),
    );
    expect(err.code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(requests).toHaveLength(1);
  });

  it('executeJava surfaces "Não autorizado" as a 200 auth error (maps to WRITE_NOT_AUTHORIZED)', async () => {
    const { client, requests } = setup(() =>
      status(200, {
        serviceName: 'ActionButtonsSP.executeJava',
        status: '0',
        statusMessage: 'Não autorizado',
      }),
    );
    const err = await errorOf(
      client.executeJava({ actionId: '98', entityName: 'AD_MANIPULADADOS', pk: { ID: 1 } }),
    );
    expect(err.code).toBe('SANKHYA_AUTH_ERROR');
    expect(err.details?.httpStatus).toBe(200);
    expect(requests).toHaveLength(1);
  });

  it('removeRecords sends the delete-by-pk envelope and returns the raw status', async () => {
    const { client, requests } = setup(() => ok({}, { status: '1', transactionId: 'TXR' }));
    const out = await client.removeRecords({
      entityName: 'AD_MANIPULADADOS',
      pks: [{ ID: '777' }],
    });
    expect(requests[0]).toEqual({
      module: 'mge',
      serviceName: 'DatasetSP.removeRecords',
      requestBody: {
        entityName: 'AD_MANIPULADADOS',
        standAlone: false,
        pks: [{ ID: '777' }],
      },
    });
    expect(out.status).toBe('1');
    expect(out.transactionId).toBe('TXR');
  });

  it('removeRecords is sent exactly once on an ambiguous outcome (it is a write)', async () => {
    const { client, requests } = setup(() => status(503));
    const err = await errorOf(
      client.removeRecords({ entityName: 'AD_MANIPULADADOS', pks: [{ ID: '1' }] }),
    );
    expect(err.code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(requests).toHaveLength(1);
  });

  it('uses the module in the URL', async () => {
    const urls: string[] = [];
    const fetch = ((url: string | URL) => {
      urls.push(String(url));
      return Promise.resolve(
        new Response(JSON.stringify({ status: '1', responseBody: {} }), { status: 200 }),
      );
    }) as typeof globalThis.fetch;
    const tokens: TokenProvider = { getToken: () => Promise.resolve('t'), invalidate: () => {} };
    const transport = createGatewayTransport({
      baseUrl: 'https://gateway.test',
      tokens,
      fetch,
      timeoutMs: 1_000,
      maxResponseBytes: 10_000,
    });
    const client = new SankhyaClient({
      transport,
      tokens,
      breaker: new CircuitBreaker({ failureThreshold: 5, resetAfterMs: 1_000 }),
      rate: new CallRateLimiter(600),
      concurrency: new ConcurrencyLimiter(1),
      retry: { maxRetries: 0, baseMs: 1 },
    });
    await client.call(
      { module: 'mgecom', serviceName: 'CACSP.cancelarNota', requestBody: {} },
      { idempotent: false },
    );
    expect(urls).toEqual([
      'https://gateway.test/gateway/v1/mgecom/service.sbr?serviceName=CACSP.cancelarNota&outputType=json',
    ]);
  });

  it('refuses service names that could alter the URL', async () => {
    const { client } = setup(() => ok({}));
    const tokens: TokenProvider = { getToken: () => Promise.resolve('t'), invalidate: () => {} };
    const transport = createGatewayTransport({
      baseUrl: 'https://gateway.test',
      tokens,
      fetch: (() => Promise.reject(new Error('must not be called'))) as typeof globalThis.fetch,
      timeoutMs: 1_000,
      maxResponseBytes: 1_000,
    });
    await expect(
      transport.send({ module: 'mge', serviceName: '../admin?x=1', requestBody: {} }),
    ).rejects.toThrow(/service name/);
    expect(client).toBeDefined();
  });

  it('traces contain no bodies or tokens', async () => {
    const { client, traces } = setup(() =>
      ok({ fieldsMetadata: [{ name: 'SECRETCOL' }], rows: [['row-value']] }),
    );
    await client.executeQuery("SELECT 'sql-literal' FROM TGFPAR");
    expect(traces).toEqual([
      {
        serviceName: 'DbExplorerSP.executeQuery',
        module: 'mge',
        durationMs: expect.any(Number) as number,
        attempts: 1,
        outcome: 'ok',
      },
    ]);
    const text = JSON.stringify(traces);
    for (const leak of ['sql-literal', 'row-value', 'SECRETCOL', 'access-token-value']) {
      expect(text).not.toContain(leak);
    }
  });

  it('records failed calls in the trace with the error code', async () => {
    const { client, traces } = setup(() => status(200, { status: '0', statusMessage: 'x' }));
    await errorOf(client.executeQuery('SELECT 1'));
    expect(traces[0]).toMatchObject({ outcome: 'error', errorCode: 'SANKHYA_API_ERROR' });
  });

  it('the breaker opens after repeated 5xx and then fails fast', async () => {
    const { client, transport } = setup(() => status(502), { threshold: 3, maxRetries: 2 });
    expect((await errorOf(client.executeQuery('SELECT 1'))).code).toBe('SANKHYA_UNAVAILABLE');
    expect(transport.send).toHaveBeenCalledTimes(3);
    expect((await errorOf(client.executeQuery('SELECT 1'))).code).toBe('SANKHYA_UNAVAILABLE');
    expect(transport.send).toHaveBeenCalledTimes(3);
  });

  it('business errors do not open the breaker', async () => {
    const { client, transport } = setup(() => status(200, { status: '0', statusMessage: 'x' }), {
      threshold: 2,
    });
    for (let i = 0; i < 4; i++) await errorOf(client.executeQuery('SELECT 1'));
    expect(transport.send).toHaveBeenCalledTimes(4);
  });

  it('a cancelled call stops without another attempt', async () => {
    const controller = new AbortController();
    const { client, transport } = setup(() => {
      controller.abort();
      return status(503);
    });
    const err = await errorOf(client.executeQuery('SELECT 1', controller.signal));
    expect(err.code).toBe('QUERY_CANCELLED');
    expect(transport.send).toHaveBeenCalledTimes(1);
  });
});
