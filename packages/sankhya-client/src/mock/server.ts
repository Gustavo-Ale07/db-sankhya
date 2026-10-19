import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { findTableByEntity, seedMockDataset, type MockTable } from './dataset';
import { gateMockQuery } from './gate';

/**
 * Fictitious Sankhya gateway for tests and demo mode. It speaks the documented request and
 * envelope shapes (audit §3.1–3.2) over an in-memory PGlite database seeded with invented data.
 * Behaviour the official docs do not describe (page size, date formatting, the cancel flag) is
 * the mock's own choice and must not be read as how the real gateway behaves.
 */

export type MockFault =
  /** HTTP 403 with GTW3403, as for an invalid or expired token. */
  | { type: 'tokenExpired' }
  /** HTTP 200 with status "0" and "Não autorizado." from the service layer. */
  | { type: 'notAuthorizedEnvelope' }
  | { type: 'rateLimited'; retryAfterSeconds?: number }
  | { type: 'serverError'; status?: 500 | 502 | 503 | 504 }
  /** HTTP 200 with a body that is not JSON. */
  | { type: 'malformed' }
  /** HTTP 200 with a status that is neither "1" nor "0". */
  | { type: 'ambiguous' }
  /** Answers normally after `ms`. */
  | { type: 'delay'; ms: number }
  /** Applies the call, then drops the response, so a write's outcome is unknown to the caller. */
  | { type: 'responseLost' }
  /**
   * DatasetSP.save only: answers success, echoes the requested values, but does not persist the
   * listed `fields` (default: every non-key field of the record). Other fields are saved normally.
   */
  | { type: 'ignoreWrite'; fields?: string[] };

/** Narrows a queued fault to the calls it should hit. */
export interface MockFaultTarget {
  service?: string;
  /** Only executeQuery calls whose SQL contains this text (case-insensitive), e.g. `FROM TDDCAM`. */
  sqlIncludes?: string;
  /**
   * Lets this many matching calls through untouched before the fault fires, e.g.
   * `{ service: 'DatasetSP.save', after: 1 }` hits the 2nd save only. Matching calls are those
   * that satisfy `service` and `sqlIncludes`. The first matching queued fault decides the call:
   * while it is still skipping, later queued faults wait behind it.
   */
  after?: number;
}

export interface MockFaults {
  /** Faults applied in order, one per matching gateway call. */
  queue?: Array<MockFault & MockFaultTarget>;
}

export interface MockSankhyaOptions {
  seed?: number;
  clientId?: string;
  clientSecret?: string;
  xToken?: string;
  tokenTtlSeconds?: number;
  faults?: MockFaults;
  /** Rows per loadRecords page. */
  pageSize?: number;
  /** Row cap of executeQuery; larger results are cut and flagged with `burstLimit`. */
  queryRowCap?: number;
  now?: () => number;
}

export interface MockSankhya {
  /** Base URL to configure as the gateway origin when using `fetch`. */
  baseUrl: string;
  fetch: typeof fetch;
  db: PGlite;
  /** Every authenticated gateway call, in order (faulted ones included). */
  calls: Array<{ serviceName: string; requestBody?: unknown }>;
  /** Queues a fault for the next matching gateway call (optionally one service or SQL text). */
  inject(fault: MockFault, opts?: MockFaultTarget): void;
  /** Drops every queued fault that has not fired yet. */
  clearFaults(): void;
  /** Invalidates every issued token, so the next call gets GTW3403. */
  expireTokens(): void;
  handle(req: MockRequest): Promise<MockResponse>;
  close(): Promise<void>;
}

export interface MockRequest {
  method: string;
  /** Path plus query string, e.g. `/gateway/v1/mge/service.sbr?serviceName=X`. */
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
  signal?: AbortSignal;
}

export type MockResponse =
  | { kind: 'response'; status: number; headers: Record<string, string>; body: string }
  /** The connection is dropped without an answer. */
  | { kind: 'dropped' };

export const MOCK_BASE_URL = 'https://mock-sankhya.example';
export const MOCK_CREDENTIALS = {
  clientId: 'mock-client-id',
  clientSecret: 'mock-client-secret',
  xToken: 'mock-x-token',
} as const;

const SERVICES: Record<string, 'mge' | 'mgecom'> = {
  'DbExplorerSP.executeQuery': 'mge',
  'CRUDServiceProvider.loadRecords': 'mge',
  'DatasetSP.save': 'mge',
  'CACSP.cancelarNota': 'mgecom',
};

const SERVICE_PATH = /^\/gateway\/v1\/(mge|mgecom)\/service\.sbr$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Upper-cased SQL of an executeQuery request body, or '' when it has none. */
function requestSql(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const rb = isRecord(parsed) ? parsed.requestBody : undefined;
    return isRecord(rb) && typeof rb.sql === 'string' ? rb.sql.toUpperCase() : '';
  } catch {
    return '';
  }
}

export async function createMockSankhya(opts: MockSankhyaOptions = {}): Promise<MockSankhya> {
  const now = opts.now ?? Date.now;
  const creds = {
    clientId: opts.clientId ?? MOCK_CREDENTIALS.clientId,
    clientSecret: opts.clientSecret ?? MOCK_CREDENTIALS.clientSecret,
    xToken: opts.xToken ?? MOCK_CREDENTIALS.xToken,
  };
  const ttl = opts.tokenTtlSeconds ?? 300;
  const pageSize = opts.pageSize ?? 50;
  const rowCap = opts.queryRowCap ?? 1000;
  const db = new PGlite();
  await seedMockDataset(db, opts.seed ?? 42);

  const tokens = new Map<string, number>();
  const faults: Array<MockFault & MockFaultTarget> = [...(opts.faults?.queue ?? [])];
  const calls: Array<{ serviceName: string; requestBody?: unknown }> = [];
  const skipped = new Map<object, number>();

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ({
      kind: 'response',
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: JSON.stringify(body),
    }) as const;
  const envelope = (serviceName: string, responseBody: unknown, extra = {}) =>
    json(200, { serviceName, status: '1', pendingPrinting: 'false', responseBody, ...extra });
  const serviceError = (serviceName: string, message: string) =>
    json(200, { serviceName, status: '0', pendingPrinting: 'false', statusMessage: message });

  function authenticate(req: MockRequest): MockResponse {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const form = new URLSearchParams(req.body);
    const ok =
      req.headers['x-token'] === creds.xToken &&
      form.get('client_id') === creds.clientId &&
      form.get('client_secret') === creds.clientSecret &&
      form.get('grant_type') === 'client_credentials';
    if (!ok) return json(401, { error: 'invalid_client', error_description: 'Não autorizado' });
    const token = `mock.${randomBytes(24).toString('hex')}`;
    tokens.set(token, now() + ttl * 1000);
    return json(200, {
      access_token: token,
      expires_in: ttl,
      refresh_expires_in: 0,
      token_type: 'Bearer',
    });
  }

  function takeFault(serviceName: string, body: string): MockFault | undefined {
    const sql = serviceName === 'DbExplorerSP.executeQuery' ? requestSql(body) : '';
    const i = faults.findIndex(
      (f) =>
        (f.service === undefined || f.service === serviceName) &&
        (f.sqlIncludes === undefined || sql.includes(f.sqlIncludes.toUpperCase())),
    );
    if (i < 0) return undefined;
    const wanted = faults[i]!.after ?? 0;
    const seen = skipped.get(faults[i]!) ?? 0;
    if (seen < wanted) {
      skipped.set(faults[i]!, seen + 1);
      return undefined;
    }
    skipped.delete(faults[i]!);
    const [fault] = faults.splice(i, 1);
    return fault;
  }

  async function service(req: MockRequest): Promise<MockResponse> {
    const url = new URL(req.url, MOCK_BASE_URL);
    const m = SERVICE_PATH.exec(url.pathname);
    if (!m) return json(404, { error: 'not_found' });
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

    const auth = req.headers.authorization ?? '';
    const bearer = /^Bearer (\S+)$/.exec(auth);
    if (!bearer) return json(401, { error: { code: 'GTW2510', message: 'Authorization ausente' } });
    const expiry = tokens.get(bearer[1]!);
    if (expiry === undefined || expiry <= now()) {
      return json(403, { error: { code: 'GTW3403', message: 'Token inválido ou expirado' } });
    }

    const serviceName = url.searchParams.get('serviceName') ?? '';
    calls.push({ serviceName, requestBody: bodyOf(req.body) });
    const fault = takeFault(serviceName, req.body);
    if (fault) {
      const early = await applyFault(fault, req.signal);
      if (early) return early;
    }

    const module = m[1] as 'mge' | 'mgecom';
    const expected = SERVICES[serviceName];
    let response: MockResponse;
    if (!expected) {
      response = serviceError(serviceName, `Serviço não encontrado: ${serviceName}`);
    } else if (expected !== module) {
      response = serviceError(
        serviceName,
        `Serviço ${serviceName} não pertence ao módulo ${module}`,
      );
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(req.body) as unknown;
      } catch {
        return json(400, { error: 'invalid_json' });
      }
      const requestBody = isRecord(parsed) ? parsed.requestBody : undefined;
      response = await runService(serviceName, requestBody, fault);
    }
    if (fault?.type === 'responseLost') return { kind: 'dropped' };
    return response;
  }

  async function applyFault(fault: MockFault, signal?: AbortSignal) {
    switch (fault.type) {
      case 'tokenExpired':
        return json(403, { error: { code: 'GTW3403', message: 'Token inválido ou expirado' } });
      case 'notAuthorizedEnvelope':
        return json(200, { status: '0', statusMessage: 'Não autorizado.' });
      case 'rateLimited':
        return json(
          429,
          { error: { code: 'TOO_MANY_REQUESTS', message: 'Limite de requisições excedido' } },
          { 'retry-after': String(fault.retryAfterSeconds ?? 1) },
        );
      case 'serverError':
        return json(fault.status ?? 503, { error: { message: 'Serviço indisponível' } });
      case 'malformed':
        return {
          kind: 'response',
          status: 200,
          headers: { 'content-type': 'text/html' },
          body: '<html>gateway</html>',
        } as const;
      case 'ambiguous':
        return json(200, { status: '2', statusMessage: 'Processado com avisos' });
      case 'delay':
        await sleep(fault.ms, signal);
        return undefined;
      case 'responseLost':
      case 'ignoreWrite':
        return undefined;
    }
  }

  async function runService(
    serviceName: string,
    body: unknown,
    fault?: MockFault,
  ): Promise<MockResponse> {
    try {
      switch (serviceName) {
        case 'DbExplorerSP.executeQuery':
          return envelope(serviceName, await executeQuery(body));
        case 'CRUDServiceProvider.loadRecords':
          return envelope(serviceName, await loadRecords(body));
        case 'DatasetSP.save': {
          const result = await save(body, fault?.type === 'ignoreWrite' ? fault : undefined);
          return envelope(
            serviceName,
            { result },
            { transactionId: randomBytes(8).toString('hex') },
          );
        }
        case 'CACSP.cancelarNota':
          return envelope(serviceName, await cancelarNota(body));
      }
      return serviceError(serviceName, 'Serviço não encontrado');
    } catch (err) {
      return serviceError(
        serviceName,
        err instanceof MockServiceError ? err.message : 'Erro interno',
      );
    }
  }

  async function executeQuery(body: unknown) {
    const sql = isRecord(body) && typeof body.sql === 'string' ? body.sql : undefined;
    if (!sql) throw new MockServiceError('Parâmetro sql ausente');
    const gate = gateMockQuery(sql);
    if (!gate.ok) throw new MockServiceError(`Consulta recusada: ${gate.reason}`);
    const pgSql = emulateRowCap(sql.trim().replace(/;$/, ''));
    const res = await readOnly((tx) => tx.query<unknown[]>(pgSql, [], { rowMode: 'array' }));
    const rows = res.rows.slice(0, rowCap).map((r) => r.map(toWire));
    return {
      fieldsMetadata: res.fields.map((f) => ({
        name: f.name.toUpperCase(),
        userType: userType(f.dataTypeID),
      })),
      rows,
      burstLimit: res.rows.length > rowCap,
    };
  }

  async function loadRecords(body: unknown) {
    const dataSet = isRecord(body) && isRecord(body.dataSet) ? body.dataSet : undefined;
    if (!dataSet || typeof dataSet.rootEntity !== 'string') {
      throw new MockServiceError('dataSet.rootEntity ausente');
    }
    if (dataSet.offsetPage === undefined)
      throw new MockServiceError('GTW2509 offsetPage obrigatório');
    const table = tableFor(dataSet.rootEntity);
    const offset = Number(dataSet.offsetPage);
    if (!Number.isInteger(offset) || offset < 0) throw new MockServiceError('offsetPage inválido');
    const listRaw =
      isRecord(dataSet.entity) && isRecord(dataSet.entity.fieldset)
        ? dataSet.entity.fieldset.list
        : undefined;
    const fields =
      typeof listRaw === 'string' && listRaw.trim() !== '*'
        ? listRaw.split(',').map((f) => f.trim())
        : table.columns.map((c) => c.name);
    for (const f of fields) checkColumn(table, f);

    let where = '';
    const params: unknown[] = [];
    if (isRecord(dataSet.criteria)) {
      const exprNode = dataSet.criteria.expression;
      const expression = isRecord(exprNode) && typeof exprNode.$ === 'string' ? exprNode.$ : '';
      const rawParams = dataSet.criteria.parameter;
      const list = Array.isArray(rawParams) ? rawParams : rawParams ? [rawParams] : [];
      for (const p of list) params.push(isRecord(p) ? p.$ : undefined);
      where = criteriaToSql(table, expression, params.length);
    }
    const order = table.pk.join(', ');
    const sql =
      `SELECT ${fields.join(', ')} FROM ${table.table}${where ? ` WHERE ${where}` : ''} ` +
      `ORDER BY ${order} LIMIT ${pageSize + 1} OFFSET ${offset * pageSize}`;
    const res = await readOnly((tx) => tx.query<unknown[]>(sql, params, { rowMode: 'array' }));
    const page = res.rows.slice(0, pageSize).map((row) => {
      const entity: Record<string, unknown> = {};
      row.forEach((v, i) => {
        entity[`f${i}`] = v === null ? {} : { $: String(toWire(v)) };
      });
      return entity;
    });
    return {
      entities: {
        total: String(page.length),
        hasMoreResult: String(res.rows.length > pageSize),
        offsetPage: String(offset),
        metadata: { fields: { field: fields.map((name) => ({ name })) } },
        entity: page.length === 1 ? page[0] : page,
      },
    };
  }

  async function save(body: unknown, ignore?: { fields?: string[] }): Promise<unknown[][]> {
    if (!isRecord(body) || typeof body.entityName !== 'string' || !Array.isArray(body.fields)) {
      throw new MockServiceError('entityName e fields são obrigatórios');
    }
    const table = tableFor(body.entityName);
    const fields = body.fields.map((f) => String(f));
    for (const f of fields) checkColumn(table, f);
    const records = Array.isArray(body.records) ? body.records : [];
    if (records.length === 0) throw new MockServiceError('Nenhum registro informado');

    return db.transaction(async (tx) => {
      const out: unknown[][] = [];
      for (const rec of records) {
        if (!isRecord(rec) || !isRecord(rec.values))
          throw new MockServiceError('Registro inválido');
        const values = new Map<string, unknown>();
        for (const [key, value] of Object.entries(rec.values)) {
          const field = fields[Number(key)];
          if (field === undefined || !/^\d+$/.test(key)) {
            throw new MockServiceError(`Índice de campo inválido: ${key}`);
          }
          values.set(field, value);
        }
        const requested = new Map(values);
        if (ignore) {
          for (const f of [...values.keys()]) {
            if (
              !table.pk.includes(f) &&
              (ignore.fields === undefined || ignore.fields.includes(f))
            ) {
              values.delete(f);
            }
          }
        }
        let pk: Record<string, unknown>;
        if (isRecord(rec.pk)) {
          pk = rec.pk;
          for (const k of table.pk) {
            if (!(k in pk)) throw new MockServiceError(`Chave ${k} ausente`);
          }
          const sets = [...values.keys()].filter((f) => !table.pk.includes(f));
          if (sets.length > 0) {
            const params: unknown[] = [];
            const setSql = sets.map((f) => {
              params.push(values.get(f));
              return `${f} = $${params.length}`;
            });
            const whereSql = table.pk.map((k) => {
              params.push(pk[k]);
              return `${k} = $${params.length}`;
            });
            const res = await tx.query(
              `UPDATE ${table.table} SET ${setSql.join(', ')} WHERE ${whereSql.join(' AND ')}`,
              params,
            );
            if (res.affectedRows !== 1) throw new MockServiceError('Registro não encontrado');
          }
        } else {
          pk = {};
          for (const k of table.pk) {
            if (values.has(k)) {
              pk[k] = values.get(k);
            } else if (table.pk.length === 1) {
              const next = await tx.query<{ n: number }>(
                `SELECT COALESCE(MAX(${k}), 0) + 1 AS n FROM ${table.table}`,
              );
              pk[k] = next.rows[0]!.n;
              values.set(k, pk[k]);
            } else {
              throw new MockServiceError(`Chave ${k} obrigatória`);
            }
          }
          const cols = [...values.keys()];
          const params = cols.map((c) => values.get(c));
          try {
            await tx.query(
              `INSERT INTO ${table.table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
              params,
            );
          } catch {
            throw new MockServiceError('Não foi possível incluir o registro');
          }
        }
        const params: unknown[] = [];
        const whereSql = table.pk.map((k) => {
          params.push(pk[k]);
          return `${k} = $${params.length}`;
        });
        const row = await tx.query<unknown[]>(
          `SELECT ${fields.join(', ')} FROM ${table.table} WHERE ${whereSql.join(' AND ')}`,
          params,
          { rowMode: 'array' },
        );
        const saved = row.rows[0];
        if (!saved) throw new MockServiceError('Registro não encontrado');
        out.push(
          saved.map((v, i) => {
            const name = fields[i]!;
            const shown = ignore && requested.has(name) ? requested.get(name) : v;
            return shown === null || shown === undefined ? null : String(toWire(shown));
          }),
        );
      }
      return out;
    });
  }

  /** Mock-only: marks the note as cancelled (STATUSNOTA = 'C'). Not the real service contract. */
  async function cancelarNota(body: unknown) {
    const nunota = findNunota(body);
    if (nunota === undefined) throw new MockServiceError('NUNOTA ausente');
    const res = await db.query(`UPDATE TGFCAB SET STATUSNOTA = 'C' WHERE NUNOTA = $1`, [nunota]);
    if (res.affectedRows !== 1) throw new MockServiceError('Nota não encontrada');
    return { notasCanceladas: { nunota: [{ $: String(nunota) }] } };
  }

  function readOnly<T>(
    fn: (tx: Parameters<Parameters<PGlite['transaction']>[0]>[0]) => Promise<T>,
  ) {
    return db
      .transaction(async (tx) => {
        await tx.exec('SET TRANSACTION READ ONLY');
        return fn(tx);
      })
      .catch((err: unknown) => {
        if (err instanceof MockServiceError) throw err;
        const msg = err instanceof Error ? err.message : 'erro';
        throw new MockServiceError(`Erro na consulta: ${msg}`);
      });
  }

  const handle = async (req: MockRequest): Promise<MockResponse> => {
    const path = new URL(req.url, MOCK_BASE_URL).pathname;
    if (path === '/authenticate') return authenticate(req);
    return service(req);
  };

  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== MOCK_BASE_URL)
      throw new TypeError(`mock gateway: unexpected origin ${url.origin}`);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => (headers[k] = v));
    const out = await handle({
      method: request.method,
      url: url.pathname + url.search,
      headers,
      body: await request.text(),
      signal: request.signal,
    });
    if (request.signal.aborted) throw request.signal.reason;
    if (out.kind === 'dropped') throw new TypeError('fetch failed');
    return new Response(out.body, { status: out.status, headers: out.headers });
  }) as typeof fetch;

  return {
    baseUrl: MOCK_BASE_URL,
    fetch: mockFetch,
    db,
    calls,
    inject(fault, o) {
      faults.push({ ...fault, ...o });
    },
    clearFaults() {
      faults.length = 0;
    },
    expireTokens() {
      tokens.clear();
    },
    handle,
    close: () => db.close(),
  };
}

/** Serves a mock over real HTTP on `host:port` (default 127.0.0.1 and a random port). */
export async function startMockSankhyaServer(
  mock: MockSankhya,
  opts: { port?: number; host?: string } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void readBody(req).then(
      async (body) => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        const controller = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) controller.abort();
        });
        try {
          const out = await mock.handle({
            method: req.method ?? 'GET',
            url: req.url ?? '/',
            headers,
            body,
            signal: controller.signal,
          });
          if (out.kind === 'dropped') {
            req.socket.destroy();
            return;
          }
          res.writeHead(out.status, out.headers);
          res.end(out.body);
        } catch {
          if (!res.headersSent && !res.destroyed) {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end('{"error":"internal"}');
          }
        }
      },
      () => req.socket.destroy(),
    );
  });
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, host, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

class MockServiceError extends Error {}

function tableFor(entity: string): MockTable {
  const t = findTableByEntity(entity);
  if (!t) throw new MockServiceError(`Entidade não encontrada: ${entity}`);
  return t;
}

function checkColumn(table: MockTable, field: string) {
  if (!IDENT.test(field) || !table.columns.some((c) => c.name === field)) {
    throw new MockServiceError(`Campo ${field} não existe em ${table.entity}`);
  }
}

/**
 * Translates the small criteria subset the mock accepts: `this.FIELD <op> ?` terms joined by
 * AND/OR, with optional parentheses. Anything else is refused.
 */
function criteriaToSql(table: MockTable, expression: string, paramCount: number): string {
  let n = 0;
  const tokens =
    expression.match(/this\.[A-Za-z_][A-Za-z0-9_]*|<>|<=|>=|=|<|>|\?|\(|\)|[A-Za-z]+|\S/g) ?? [];
  const out: string[] = [];
  for (const t of tokens) {
    if (t.startsWith('this.')) {
      const field = t.slice(5);
      checkColumn(table, field);
      out.push(field);
    } else if (t === '?') {
      n += 1;
      out.push(`$${n}`);
    } else if (['=', '<>', '<', '>', '<=', '>=', '(', ')'].includes(t)) {
      out.push(t);
    } else if (/^(AND|OR|LIKE|IS|NOT|NULL)$/i.test(t)) {
      out.push(t.toUpperCase());
    } else {
      throw new MockServiceError(`Critério não suportado pelo mock: ${t}`);
    }
  }
  if (n !== paramCount) throw new MockServiceError('Quantidade de parâmetros não confere');
  return out.join(' ');
}

function findNunota(value: unknown, depth = 0): number | undefined {
  if (depth > 6) return undefined;
  if (Array.isArray(value)) {
    for (const v of value) {
      const found = findNunota(v, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const [k, v] of Object.entries(value)) {
    if (k.toUpperCase() === 'NUNOTA') {
      const raw = isRecord(v) ? v.$ : Array.isArray(v) ? (isRecord(v[0]) ? v[0].$ : v[0]) : v;
      const n = Number(raw);
      if (Number.isInteger(n)) return n;
    }
    const found = findNunota(v, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function bodyOf(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed.requestBody : undefined;
  } catch {
    return undefined;
  }
}

function toWire(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'bigint') return v.toString();
  return v;
}

const ORACLE_ROW_CAP = /^SELECT \* FROM \(([\s\S]+)\) WHERE ROWNUM <= (\d+)$/;
const MSSQL_ROW_CAP = /^SELECT TOP \((\d+)\) \* FROM \(([\s\S]+)\) AS dbx_q$/;

/**
 * The mock runs on Postgres, which knows neither Oracle's ROWNUM nor T-SQL's TOP. The exact
 * row-cap wrappers the API puts around a read are rewritten to LIMIT (mock-only emulation); any
 * other statement runs unchanged. The original statement already passed the gate.
 */
function emulateRowCap(sql: string): string {
  const oracle = ORACLE_ROW_CAP.exec(sql);
  if (oracle) return `SELECT * FROM (${oracle[1]}) AS dbx_q LIMIT ${Number(oracle[2])}`;
  const mssql = MSSQL_ROW_CAP.exec(sql);
  if (mssql) return `SELECT * FROM (${mssql[2]}) AS dbx_q LIMIT ${Number(mssql[1])}`;
  return sql;
}

/** Field type letter for executeQuery metadata (mock-only mapping from Postgres type OIDs). */
function userType(oid: number): string {
  if ([20, 21, 23].includes(oid)) return 'I';
  if ([700, 701, 1700].includes(oid)) return 'F';
  if ([1082].includes(oid)) return 'D';
  if ([1114, 1184].includes(oid)) return 'H';
  return 'S';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
