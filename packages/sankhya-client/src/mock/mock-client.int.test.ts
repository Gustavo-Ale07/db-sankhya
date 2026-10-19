import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isAppError, type AppError } from '@dbx/shared';
import { createTokenProvider } from '../auth';
import { CircuitBreaker } from '../circuit';
import { SankhyaClient } from '../client';
import { CallRateLimiter, ConcurrencyLimiter } from '../limiter';
import { createGatewayTransport } from '../transport';
import {
  MOCK_CREDENTIALS,
  createMockSankhya,
  startMockSankhyaServer,
  type MockSankhya,
} from './server';

let mock: MockSankhya;
let server: { url: string; close(): Promise<void> };

beforeAll(async () => {
  mock = await createMockSankhya({ seed: 11 });
  server = await startMockSankhyaServer(mock);
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

function makeClient(opts: { timeoutMs?: number } = {}) {
  const tokens = createTokenProvider({
    authUrl: `${server.url}/authenticate`,
    ...MOCK_CREDENTIALS,
    fetch: globalThis.fetch,
    timeoutMs: 5_000,
  });
  const transport = createGatewayTransport({
    baseUrl: server.url,
    tokens,
    fetch: globalThis.fetch,
    timeoutMs: opts.timeoutMs ?? 5_000,
    maxResponseBytes: 5_000_000,
  });
  return new SankhyaClient({
    transport,
    tokens,
    breaker: new CircuitBreaker({ failureThreshold: 50, resetAfterMs: 60_000 }),
    rate: new CallRateLimiter(6_000),
    concurrency: new ConcurrencyLimiter(4),
    retry: { maxRetries: 2, baseMs: 1, maxMs: 5 },
  });
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => new Error('expected a rejection'),
    (err: unknown) => err,
  );
  if (!isAppError(e)) throw e;
  return e;
}

const saveExample = (client: SankhyaClient, descricao: string) =>
  client.save({
    entityName: 'AD_EXEMPLO',
    fields: ['ID', 'DESCRICAO'],
    records: [{ values: { DESCRICAO: descricao } }],
  });

const countExample = async (descricao: string) =>
  (
    await mock.db.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM AD_EXEMPLO WHERE DESCRICAO = $1',
      [descricao],
    )
  ).rows[0]!.n;

afterEach(() => {
  mock.clearFaults();
});

describe('SankhyaClient against the mock gateway', () => {
  it('reads with executeQuery and loadRecords', async () => {
    const client = makeClient();
    const q = await client.executeQuery('SELECT CODPROD, DESCRPROD FROM TGFPRO WHERE CODPROD <= 3');
    expect(q.columns).toEqual(['CODPROD', 'DESCRPROD']);
    expect(q.rows).toHaveLength(3);
    const r = await client.loadRecords({
      rootEntity: 'Produto',
      fields: ['CODPROD', 'DESCRPROD'],
      criteria: { expression: 'this.CODPROD = ?', parameters: [{ value: 2, type: 'I' }] },
    });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.CODPROD).toBe('2');
  });

  it('inserts and updates through DatasetSP.save', async () => {
    const client = makeClient();
    const out = await saveExample(client, 'via client');
    const id = out.results[0]![0];
    expect(await countExample('via client')).toBe(1);
    await client.save({
      entityName: 'AD_EXEMPLO',
      fields: ['DESCRICAO'],
      records: [{ pk: { ID: Number(id) }, values: { DESCRICAO: 'via client (editado)' } }],
    });
    expect(await countExample('via client (editado)')).toBe(1);
  });

  it('a GTW3403 on a read re-authenticates once and succeeds', async () => {
    const client = makeClient();
    await client.executeQuery('SELECT 1 AS X');
    mock.inject({ type: 'tokenExpired' });
    await expect(client.executeQuery('SELECT 1 AS X')).resolves.toMatchObject({ rows: [[1]] });
  });

  it('expired tokens on the server are recovered for reads', async () => {
    const client = makeClient();
    await client.executeQuery('SELECT 1 AS X');
    mock.expireTokens();
    await expect(client.executeQuery('SELECT 2 AS X')).resolves.toMatchObject({ rows: [[2]] });
  });

  it('a GTW3403 on a write re-authenticates and sends it once more, never twice applied', async () => {
    const client = makeClient();
    mock.inject({ type: 'tokenExpired' }, { service: 'DatasetSP.save' });
    await saveExample(client, 'after reauth');
    expect(await countExample('after reauth')).toBe(1);
  });

  it('"Não autorizado" inside a 200 envelope is not replayed for writes', async () => {
    const client = makeClient();
    mock.inject({ type: 'notAuthorizedEnvelope' }, { service: 'DatasetSP.save' });
    expect((await errorOf(saveExample(client, 'not authorized'))).code).toBe('SANKHYA_AUTH_ERROR');
    expect(await countExample('not authorized')).toBe(0);
  });

  it('429 with Retry-After is retried for reads', async () => {
    const client = makeClient();
    mock.inject({ type: 'rateLimited', retryAfterSeconds: 0 });
    await expect(client.executeQuery('SELECT 3 AS X')).resolves.toMatchObject({ rows: [[3]] });
  });

  it('429 on a write is reported as rate limiting and nothing is written', async () => {
    const client = makeClient();
    mock.inject({ type: 'rateLimited', retryAfterSeconds: 0 }, { service: 'DatasetSP.save' });
    expect((await errorOf(saveExample(client, 'rate limited'))).code).toBe('SANKHYA_RATE_LIMITED');
    expect(await countExample('rate limited')).toBe(0);
  });

  it('5xx is retried for reads and is an unknown outcome for writes', async () => {
    const client = makeClient();
    mock.inject({ type: 'serverError', status: 502 });
    await expect(client.executeQuery('SELECT 4 AS X')).resolves.toMatchObject({ rows: [[4]] });
    mock.inject({ type: 'serverError', status: 503 }, { service: 'DatasetSP.save' });
    expect((await errorOf(saveExample(client, 'five hundred'))).code).toBe('WRITE_OUTCOME_UNKNOWN');
  });

  it('a malformed body is a bad response', async () => {
    const client = makeClient();
    for (let i = 0; i < 3; i++) mock.inject({ type: 'malformed' });
    expect((await errorOf(client.executeQuery('SELECT 1 AS X'))).code).toBe('SANKHYA_BAD_RESPONSE');
  });

  it('an ambiguous status on a write is an unknown outcome', async () => {
    const client = makeClient();
    mock.inject({ type: 'ambiguous' }, { service: 'DatasetSP.save' });
    expect((await errorOf(saveExample(client, 'ambiguous'))).code).toBe('WRITE_OUTCOME_UNKNOWN');
  });

  it('a slow answer times out', async () => {
    const client = makeClient({ timeoutMs: 100 });
    for (let i = 0; i < 3; i++) mock.inject({ type: 'delay', ms: 1_000 });
    expect((await errorOf(client.executeQuery('SELECT 1 AS X'))).code).toBe('SANKHYA_TIMEOUT');
  });

  it('a write applied but whose response is lost is an unknown outcome and is not resent', async () => {
    const client = makeClient();
    mock.inject({ type: 'responseLost' }, { service: 'DatasetSP.save' });
    const before = mock.calls.length;
    expect((await errorOf(saveExample(client, 'response lost'))).code).toBe(
      'WRITE_OUTCOME_UNKNOWN',
    );
    expect(mock.calls.length - before).toBe(1);
    expect(await countExample('response lost')).toBe(1);
  });

  it('a fault on the 2nd save only: the 1st succeeds, the 2nd fails and is not resent', async () => {
    const client = makeClient();
    mock.inject({ type: 'serverError', status: 500 }, { service: 'DatasetSP.save', after: 1 });
    const saves = () => mock.calls.filter((c) => c.serviceName === 'DatasetSP.save').length;
    const before = saves();
    await saveExample(client, 'nth save one');
    expect((await errorOf(saveExample(client, 'nth save two'))).code).toBe('WRITE_OUTCOME_UNKNOWN');
    expect(saves() - before).toBe(2);
    expect(await countExample('nth save two')).toBe(0);
  });

  it('a failing verification read errors once, and the saved row is still readable after', async () => {
    const client = makeClient();
    const out = await saveExample(client, 'verify me');
    const id = Number(out.results[0]![0]);
    mock.inject({ type: 'malformed' }, { service: 'CRUDServiceProvider.loadRecords' });
    const read = () =>
      client.loadRecords({
        rootEntity: 'AD_EXEMPLO',
        fields: ['DESCRICAO'],
        criteria: { expression: 'this.ID = ?', parameters: [{ value: id, type: 'I' }] },
      });
    await errorOf(read());
    expect((await read()).records[0]!.DESCRICAO).toBe('verify me');
  });

  it('ignoreWrite: the client sees success but a read-back shows the old value', async () => {
    const client = makeClient();
    const out = await saveExample(client, 'before ignore');
    const id = Number(out.results[0]![0]);
    mock.inject({ type: 'ignoreWrite' }, { service: 'DatasetSP.save' });
    const saved = await client.save({
      entityName: 'AD_EXEMPLO',
      fields: ['DESCRICAO'],
      records: [{ pk: { ID: id }, values: { DESCRICAO: 'after ignore' } }],
    });
    expect(saved.results[0]).toEqual(['after ignore']);
    const read = await client.loadRecords({
      rootEntity: 'AD_EXEMPLO',
      fields: ['DESCRICAO'],
      criteria: { expression: 'this.ID = ?', parameters: [{ value: id, type: 'I' }] },
    });
    expect(read.records[0]!.DESCRICAO).toBe('before ignore');
  });

  it('wrong credentials are an authentication error', async () => {
    const tokens = createTokenProvider({
      authUrl: `${server.url}/authenticate`,
      ...MOCK_CREDENTIALS,
      clientSecret: 'wrong',
      fetch: globalThis.fetch,
      timeoutMs: 5_000,
    });
    expect((await errorOf(tokens.getToken())).code).toBe('SANKHYA_AUTH_ERROR');
  });
});
