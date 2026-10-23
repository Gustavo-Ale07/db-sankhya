/** Gateway module: `mge` hosts most services; `mgecom` hosts the commercial ones (CACSP.*). */
export type GatewayModule = 'mge' | 'mgecom';

export interface GatewayRequest {
  module: GatewayModule;
  serviceName: string;
  requestBody: unknown;
}

/** The JSON envelope every `service.sbr` call answers with. */
export interface GatewayEnvelope {
  /** "1" success, "0" error; anything else is treated as not successful. */
  status: string;
  statusMessage?: string;
  transactionId?: string;
  responseBody?: unknown;
}

export interface TransportResponse {
  httpStatus: number;
  /** Parsed JSON, or undefined when the body was not JSON. */
  body: unknown;
  retryAfterSeconds?: number;
}

export interface GatewayTransport {
  send(req: GatewayRequest, signal?: AbortSignal): Promise<TransportResponse>;
}

/** Metadata about one logical gateway call. Never holds bodies, tokens or credentials. */
export interface CallTrace {
  serviceName: string;
  module: GatewayModule;
  durationMs: number;
  attempts: number;
  outcome: 'ok' | 'error';
  errorCode?: string;
}

/** Value type of a `loadRecords` criteria parameter: integer, string, date, float. */
export type CriteriaParamType = 'I' | 'S' | 'D' | 'F';

export interface LoadRecordsInput {
  /** Entity (instance) name from the data dictionary, e.g. the one mapped to TGFPAR. */
  rootEntity: string;
  fields: string[];
  criteria?: {
    expression: string;
    parameters: Array<{ value: string | number; type: CriteriaParamType }>;
  };
  offsetPage?: number;
}

export interface LoadRecordsResult {
  records: Record<string, unknown>[];
  hasMore: boolean;
}

export interface SaveInput {
  entityName: string;
  fields: string[];
  /** `pk` present: update of that row; absent: insert. `values` is keyed by field name. */
  records: Array<{ pk?: Record<string, unknown>; values: Record<string, unknown> }>;
}

export interface SaveResult {
  results: unknown[][];
  transactionId?: string;
}

/**
 * Input to `DatasetSP.removeRecords`: deletes records by primary key. Used by the server-side
 * ("Executa Banco") path to clean up the dedicated AD_MANIPULADADOS record it created to carry
 * the PL/SQL block, once the action has run.
 *
 * NOTE: as with {@link ExecuteJavaInput}, the exact envelope this service expects has NOT yet
 * been confirmed against the test base (see docs/server-sql.md). Cleanup is therefore treated as
 * best-effort by the caller: a failure here never masks the real outcome of the action.
 */
export interface RemoveRecordsInput {
  entityName: string;
  /** One `{ field: value }` map per record to delete. */
  pks: Array<Record<string, string | number>>;
}

export interface RemoveRecordsResult {
  status: string;
  statusMessage?: string;
  transactionId?: string;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** The gateway flagged the result as cut at its own row cap. */
  truncated: boolean;
}

/**
 * Input to `ActionButtonsSP.executeJava`: run a server-side action button (a Java/DBScript
 * routine) against one record. For the "Executa Banco" path this is action 98 on
 * AD_MANIPULADADOS, whose TEXTO holds the PL/SQL block to run.
 *
 * NOTE: the exact envelope the gateway expects for this service (field nesting, whether
 * `entityName` belongs inside `javaCall`, the `rows`/`row`/`field` shape) is built here from
 * the documented Sankhya shape but has NOT yet been confirmed against the test base — the real
 * dispatch is pending environment validation (see docs/server-sql.md).
 */
export interface ExecuteJavaInput {
  module?: GatewayModule;
  /** Numeric action id as a string, e.g. "98". */
  actionId: string;
  /** Instance (entity) name the action is bound to, e.g. "AD_MANIPULADADOS". */
  entityName: string;
  /** Primary key of the single record the action runs against (field name → value). */
  pk: Record<string, string | number>;
  refreshType?: 'NONE' | 'RETURNED' | 'REINSERT';
}

export interface ExecuteJavaResult {
  /** Raw envelope status: "1" success, "0" error. */
  status: string;
  statusMessage?: string;
  transactionId?: string;
  responseBody?: unknown;
}
