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

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** The gateway flagged the result as cut at its own row cap. */
  truncated: boolean;
}
