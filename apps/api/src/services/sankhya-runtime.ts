import {
  CallRateLimiter,
  CircuitBreaker,
  ConcurrencyLimiter,
  SankhyaClient,
  createGatewayTransport,
  createTokenProvider,
} from '@dbx/sankhya-client';
import type { CallTrace, GatewayTransport, TokenProvider } from '@dbx/sankhya-client';
import { AppError } from '@dbx/shared';
import type { AppConfig, Environment } from '../config';

export type Dialect = 'oracle' | 'mssql';
export type ConnectionMode = 'live' | 'mock';

/** A connection with its credentials in clear text. Lives in memory only, never serialized. */
export interface DecryptedConnection {
  id: string;
  name: string;
  environment: Environment;
  mode: ConnectionMode;
  baseUrl: string;
  dialect: Dialect;
  clientId: string;
  clientSecret: string;
  xToken: string;
}

export interface SankhyaRuntime {
  client: SankhyaClient;
  connectionId: string;
  environment: Environment;
  dialect: Dialect;
  mode: ConnectionMode;
  close(): void;
}

/** In-process fictitious gateway that mock connections talk to (never the network). */
export interface MockGateway {
  baseUrl: string;
  fetch: typeof fetch;
}

export interface RuntimeDeps {
  /** fetch used for live connections (tests inject a fake one). */
  fetch?: typeof fetch;
  /** Gateway of mock connections; required for a mock runtime. */
  mockGateway?: MockGateway;
  onTrace?: (trace: CallTrace) => void;
}

/** Base URL that mock connections may use instead of an allowlisted gateway host. */
export const MOCK_BASE_URL = 'mock://local';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Cheapest statement that proves authentication and the query service work. The mock gateway
 * runs on Postgres, which has no DUAL.
 */
export function probeSql(dialect: Dialect, mode: ConnectionMode = 'live'): string {
  return dialect === 'oracle' && mode === 'live' ? 'SELECT 1 AS OK FROM DUAL' : 'SELECT 1 AS OK';
}

export function createSankhyaRuntime(
  conn: DecryptedConnection,
  cfg: AppConfig,
  deps: RuntimeDeps = {},
): SankhyaRuntime {
  let gateway: { transport: GatewayTransport; tokens: TokenProvider };
  if (conn.mode === 'live') {
    gateway = httpGateway(conn.baseUrl, conn, cfg, deps.fetch ?? fetch);
  } else {
    // A mock connection never dials out, whatever base URL it was saved with.
    if (!deps.mockGateway)
      throw new AppError('SANKHYA_NOT_CONFIGURED', 'The mock gateway is not available');
    gateway = httpGateway(deps.mockGateway.baseUrl, conn, cfg, deps.mockGateway.fetch);
  }
  const { transport, tokens } = gateway;
  const client = new SankhyaClient({
    transport,
    tokens,
    breaker: new CircuitBreaker({ failureThreshold: 5, resetAfterMs: 30_000 }),
    rate: new CallRateLimiter(cfg.sankhya.ratePerMinute),
    concurrency: new ConcurrencyLimiter(4),
    retry: { maxRetries: 2, baseMs: 500, maxMs: 5_000 },
    ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
  });
  return {
    client,
    connectionId: conn.id,
    environment: conn.environment,
    dialect: conn.dialect,
    mode: conn.mode,
    close: () => tokens.invalidate(),
  };
}

function httpGateway(
  baseUrl: string,
  conn: DecryptedConnection,
  cfg: AppConfig,
  fetchImpl: typeof fetch,
): { transport: GatewayTransport; tokens: TokenProvider } {
  const tokens = createTokenProvider({
    authUrl: new URL('authenticate', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href,
    clientId: conn.clientId,
    clientSecret: conn.clientSecret,
    xToken: conn.xToken,
    fetch: fetchImpl,
    timeoutMs: cfg.sankhya.timeoutMs,
  });
  const transport = createGatewayTransport({
    baseUrl,
    tokens,
    fetch: fetchImpl,
    timeoutMs: cfg.sankhya.timeoutMs,
    maxResponseBytes: MAX_RESPONSE_BYTES,
  });
  return { transport, tokens };
}
