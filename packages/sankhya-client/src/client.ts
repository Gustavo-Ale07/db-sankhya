import { AppError, isAppError } from '@dbx/shared';
import type { TokenProvider } from './auth';
import { classifyGateway } from './classify';
import type { CircuitBreaker } from './circuit';
import type { CallRateLimiter } from './limiter';
import { ConcurrencyLimiter, abortError } from './limiter';
import type {
  CallTrace,
  ExecuteJavaInput,
  ExecuteJavaResult,
  GatewayEnvelope,
  GatewayRequest,
  GatewayTransport,
  LoadRecordsInput,
  LoadRecordsResult,
  QueryResult,
  RemoveRecordsInput,
  RemoveRecordsResult,
  SaveInput,
  SaveResult,
  TransportResponse,
} from './types';

export interface RetryPolicy {
  /** Extra attempts after the first one; only idempotent calls retry. */
  maxRetries: number;
  baseMs: number;
  maxMs?: number;
}

export interface SankhyaClientOptions {
  transport: GatewayTransport;
  tokens: TokenProvider;
  breaker: CircuitBreaker;
  rate: CallRateLimiter;
  concurrency: ConcurrencyLimiter;
  retry: RetryPolicy;
  onTrace?: (trace: CallTrace) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface CallOptions {
  /** Safe to repeat: reads. Non-idempotent calls (writes) are sent at most once. */
  idempotent: boolean;
  signal?: AbortSignal;
}

/** Codes that mean the gateway itself is failing (they count towards the circuit breaker). */
const INFRA_CODES = new Set<string>([
  'SANKHYA_UNAVAILABLE',
  'SANKHYA_TIMEOUT',
  'SANKHYA_BAD_RESPONSE',
  'WRITE_OUTCOME_UNKNOWN',
]);

const isInfraFailure = (err: unknown) => isAppError(err) && INFRA_CODES.has(err.code);

export class SankhyaClient {
  /** executeQuery runs one at a time: the service is heavy and shared by every user. */
  private readonly queryLane = new ConcurrencyLimiter(1);
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: SankhyaClientOptions) {
    this.sleep = opts.sleep ?? abortableSleep;
    this.random = opts.random ?? Math.random;
  }

  /**
   * One logical gateway call. Idempotent calls retry transient failures with jittered backoff;
   * any call re-authenticates once when the token is rejected. A non-idempotent call whose
   * request may have reached the gateway without a definite answer fails with
   * WRITE_OUTCOME_UNKNOWN and is never repeated.
   */
  async call(req: GatewayRequest, opts: CallOptions): Promise<GatewayEnvelope> {
    const started = performance.now();
    let attempts = 0;
    const trace = (outcome: CallTrace['outcome'], errorCode?: string) => {
      const t: CallTrace = {
        serviceName: req.serviceName,
        module: req.module,
        durationMs: Math.round(performance.now() - started),
        attempts,
        outcome,
      };
      if (errorCode) t.errorCode = errorCode;
      this.opts.onTrace?.(t);
    };

    const maxAttempts = opts.idempotent ? 1 + this.opts.retry.maxRetries : 1;
    let reauthUsed = false;
    try {
      for (let attempt = 1; ; attempt++) {
        if (opts.signal?.aborted) throw abortError(opts.signal);
        attempts += 1;
        let failure: Failure;
        try {
          const envelope = await this.opts.breaker.run(
            () => this.attempt(req, opts),
            countsForBreaker,
          );
          trace('ok');
          return envelope;
        } catch (err) {
          if (!(err instanceof AttemptFailure)) throw err;
          failure = err.failure;
        }
        if (failure.reauth && !reauthUsed && (opts.idempotent || !failure.sent)) {
          reauthUsed = true;
          this.opts.tokens.invalidate();
          attempt -= 1;
          continue;
        }
        if (failure.retryable && opts.idempotent && attempt < maxAttempts) {
          await this.backoff(attempt, failure.retryAfterSeconds, opts.signal);
          continue;
        }
        throw failure.error;
      }
    } catch (err) {
      const e = isAppError(err) ? err : abortOrUnknown(err, opts.signal);
      trace('error', e.code);
      throw e;
    }
  }

  /** Runs a read-only SQL statement through DbExplorerSP.executeQuery (gated upstream). */
  async executeQuery(sql: string, signal?: AbortSignal): Promise<QueryResult> {
    const envelope = await this.queryLane.run(
      () =>
        this.call(
          { module: 'mge', serviceName: 'DbExplorerSP.executeQuery', requestBody: { sql } },
          { idempotent: true, ...(signal ? { signal } : {}) },
        ),
      signal,
    );
    return mapQueryResult(envelope.responseBody);
  }

  async loadRecords(input: LoadRecordsInput, signal?: AbortSignal): Promise<LoadRecordsResult> {
    const dataSet: Record<string, unknown> = {
      rootEntity: input.rootEntity,
      includePresentationFields: 'N',
      offsetPage: String(input.offsetPage ?? 0),
      entity: { fieldset: { list: input.fields.join(',') } },
    };
    if (input.criteria) {
      dataSet.criteria = {
        expression: { $: input.criteria.expression },
        parameter: input.criteria.parameters.map((p) => ({ $: String(p.value), type: p.type })),
      };
    }
    const envelope = await this.call(
      { module: 'mge', serviceName: 'CRUDServiceProvider.loadRecords', requestBody: { dataSet } },
      { idempotent: true, ...(signal ? { signal } : {}) },
    );
    return mapLoadRecords(envelope.responseBody, input.fields);
  }

  /** DatasetSP.save: inserts (no pk) or updates (pk) records. Sent exactly once. */
  async save(input: SaveInput, signal?: AbortSignal): Promise<SaveResult> {
    const index = new Map(input.fields.map((f, i) => [f, String(i)]));
    const records = input.records.map((r) => {
      const values: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(r.values)) {
        const key = index.get(field);
        if (key === undefined) throw new Error(`Field ${field} is not in the save field list`);
        values[key] = value;
      }
      return r.pk ? { pk: r.pk, values } : { values };
    });
    const envelope = await this.call(
      {
        module: 'mge',
        serviceName: 'DatasetSP.save',
        requestBody: {
          entityName: input.entityName,
          standAlone: false,
          fields: input.fields,
          records,
        },
      },
      { idempotent: false, ...(signal ? { signal } : {}) },
    );
    const body = envelope.responseBody;
    const result = isRecord(body) && Array.isArray(body.result) ? body.result : [];
    const out: SaveResult = {
      results: result.map((row) => (Array.isArray(row) ? (row as unknown[]) : [row])),
    };
    if (envelope.transactionId) out.transactionId = envelope.transactionId;
    return out;
  }

  /**
   * DatasetSP.removeRecords: deletes records by primary key. Sent exactly once (idempotent:
   * false), like every other write. Used to clean up the dedicated AD_MANIPULADADOS record of
   * the server-side path; the caller treats any failure here as best-effort (an orphaned record,
   * not a failed operation). The envelope shape is documented-but-unconfirmed (see types).
   */
  async removeRecords(
    input: RemoveRecordsInput,
    signal?: AbortSignal,
  ): Promise<RemoveRecordsResult> {
    const envelope = await this.call(
      {
        module: 'mge',
        serviceName: 'DatasetSP.removeRecords',
        requestBody: {
          entityName: input.entityName,
          standAlone: false,
          pks: input.pks,
        },
      },
      { idempotent: false, ...(signal ? { signal } : {}) },
    );
    const out: RemoveRecordsResult = { status: envelope.status };
    if (envelope.statusMessage !== undefined) out.statusMessage = envelope.statusMessage;
    if (envelope.transactionId !== undefined) out.transactionId = envelope.transactionId;
    return out;
  }

  /**
   * ActionButtonsSP.executeJava: runs a server-side action button against one record. Sent
   * exactly once (idempotent: false) — a DBScript routine may have side effects, so an
   * ambiguous outcome becomes WRITE_OUTCOME_UNKNOWN and is never replayed. A "Não autorizado"
   * envelope surfaces as SANKHYA_AUTH_ERROR with httpStatus 200, which the caller maps to
   * SANKHYA_WRITE_NOT_AUTHORIZED, exactly like DatasetSP.save.
   */
  async executeJava(input: ExecuteJavaInput, signal?: AbortSignal): Promise<ExecuteJavaResult> {
    const field = Object.entries(input.pk).map(([fieldName, value]) => ({
      fieldName,
      $: String(value),
    }));
    const envelope = await this.call(
      {
        module: input.module ?? 'mge',
        serviceName: 'ActionButtonsSP.executeJava',
        requestBody: {
          javaCall: {
            actionID: input.actionId,
            entityName: input.entityName,
            refreshType: input.refreshType ?? 'NONE',
            rows: { row: [{ field }] },
          },
        },
      },
      { idempotent: false, ...(signal ? { signal } : {}) },
    );
    const out: ExecuteJavaResult = { status: envelope.status };
    if (envelope.statusMessage !== undefined) out.statusMessage = envelope.statusMessage;
    if (envelope.transactionId !== undefined) out.transactionId = envelope.transactionId;
    if (envelope.responseBody !== undefined) out.responseBody = envelope.responseBody;
    return out;
  }

  /** One HTTP exchange. Resolves on success; throws AttemptFailure for anything retryable. */
  private async attempt(req: GatewayRequest, opts: CallOptions): Promise<GatewayEnvelope> {
    let res: TransportResponse;
    try {
      await this.opts.rate.take(opts.signal);
      res = await this.opts.concurrency.run(
        () => this.opts.transport.send(req, opts.signal),
        opts.signal,
      );
    } catch (err) {
      if (opts.signal?.aborted) throw abortError(opts.signal);
      const error = isAppError(err) ? err : new AppError('SANKHYA_UNAVAILABLE', 'Gateway failure');
      // The token request failed: the service request itself never left.
      const notSent = error.details?.stage === 'auth';
      if (!opts.idempotent && !notSent) throw outcomeUnknown(req, error);
      const retryable = error.code !== 'SANKHYA_AUTH_ERROR';
      throw new AttemptFailure({ error, retryable, reauth: false, sent: !notSent });
    }

    const c = classifyGateway(res.httpStatus, res.body);
    if (c.ok) return c.envelope;
    // Only HTTP-level rejections by the gateway (429, 401/403 token errors) prove the service never
    // ran. A "não autorizado" inside an HTTP 200 envelope comes from the service layer, so a write
    // that receives one is treated as sent and never replayed.
    const rejectedBeforeService =
      c.code === 'SANKHYA_RATE_LIMITED' ||
      (c.reauth && (res.httpStatus === 401 || res.httpStatus === 403));
    const unclear = c.retryable || c.ambiguous === true || c.code === 'SANKHYA_BAD_RESPONSE';
    if (!opts.idempotent && !rejectedBeforeService && unclear) {
      throw outcomeUnknown(req, new AppError(c.code, c.message));
    }
    const error = new AppError(c.code, c.message, {
      serviceName: req.serviceName,
      httpStatus: res.httpStatus,
    });
    const failure: Failure = {
      error,
      retryable: c.retryable,
      reauth: c.reauth,
      sent: !rejectedBeforeService,
    };
    if (res.retryAfterSeconds !== undefined) failure.retryAfterSeconds = res.retryAfterSeconds;
    throw new AttemptFailure(failure);
  }

  private async backoff(
    attempt: number,
    retryAfterSeconds: number | undefined,
    signal?: AbortSignal,
  ) {
    const maxMs = this.opts.retry.maxMs ?? 8_000;
    const exp = Math.min(maxMs, this.opts.retry.baseMs * 2 ** (attempt - 1));
    const jittered = Math.round(exp / 2 + this.random() * (exp / 2));
    const hinted = retryAfterSeconds !== undefined ? Math.min(maxMs, retryAfterSeconds * 1000) : 0;
    await this.sleep(Math.max(jittered, hinted), signal);
  }
}

interface Failure {
  error: AppError;
  retryable: boolean;
  reauth: boolean;
  /** The request may have reached the service. */
  sent: boolean;
  retryAfterSeconds?: number;
}

class AttemptFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error.message);
    this.name = 'AttemptFailure';
  }
}

function countsForBreaker(err: unknown): boolean {
  return isInfraFailure(err instanceof AttemptFailure ? err.failure.error : err);
}

function outcomeUnknown(req: GatewayRequest, cause: AppError): AppError {
  return new AppError(
    'WRITE_OUTCOME_UNKNOWN',
    `The gateway did not confirm ${req.serviceName}. The write may or may not have been applied: ` +
      'check the record in Sankhya before trying again.',
    { serviceName: req.serviceName, cause: cause.code },
  );
}

function abortOrUnknown(err: unknown, signal?: AbortSignal): AppError {
  if (signal?.aborted) return abortError(signal);
  return new AppError('SANKHYA_UNAVAILABLE', 'Unexpected failure calling the Sankhya gateway.', {
    cause: err instanceof Error ? err.name : typeof err,
  });
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function badShape(what: string): AppError {
  return new AppError(
    'SANKHYA_BAD_RESPONSE',
    `Unexpected ${what} response shape from the gateway.`,
  );
}

export function mapQueryResult(body: unknown): QueryResult {
  if (!isRecord(body) || !Array.isArray(body.fieldsMetadata) || !Array.isArray(body.rows)) {
    throw badShape('executeQuery');
  }
  const columns = body.fieldsMetadata.map((f, i) =>
    isRecord(f) && typeof f.name === 'string' ? f.name : `COL${i + 1}`,
  );
  const rows = body.rows.map((r) => {
    if (!Array.isArray(r)) throw badShape('executeQuery');
    return r as unknown[];
  });
  return { columns, rows, truncated: body.burstLimit === true || body.burstLimit === 'true' };
}

/**
 * loadRecords answers `entities.entity` as one object or a list, with values under `f0..fn`
 * wrapped as `{ "$": value }`; the field order comes from `entities.metadata.fields.field`.
 */
export function mapLoadRecords(body: unknown, requested: string[]): LoadRecordsResult {
  if (!isRecord(body) || !isRecord(body.entities)) throw badShape('loadRecords');
  const entities = body.entities;
  const metaFields =
    isRecord(entities.metadata) && isRecord(entities.metadata.fields)
      ? entities.metadata.fields.field
      : undefined;
  const names = (Array.isArray(metaFields) ? metaFields : metaFields ? [metaFields] : []).map(
    (f, i) => (isRecord(f) && typeof f.name === 'string' ? f.name : (requested[i] ?? `f${i}`)),
  );
  const raw = entities.entity;
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
  const records = list.map((entity) => {
    if (!isRecord(entity)) throw badShape('loadRecords');
    const record: Record<string, unknown> = {};
    names.forEach((name, i) => {
      const cell = entity[`f${i}`];
      record[name] = isRecord(cell) && '$' in cell ? cell.$ : (cell ?? null);
    });
    return record;
  });
  const more = entities.hasMoreResult;
  return { records, hasMore: more === true || more === 'true' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
