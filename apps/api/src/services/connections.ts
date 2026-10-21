import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { asc, eq } from 'drizzle-orm';
import { connections } from '@dbx/database';
import type { ConnectionRow, Database } from '@dbx/database';
import { createMockSankhya } from '@dbx/sankhya-client/mock';
import { AppError, isAppError } from '@dbx/shared';
import type { AppConfig, Environment } from '../config';
import { decryptSecret, encryptSecret } from '../security/secretbox';
import { assertGatewayUrlShape, assertSafeGatewayUrl } from '../security/ssrf';
import { MOCK_BASE_URL, createSankhyaRuntime, probeSql } from './sankhya-runtime';
import type {
  ConnectionMode,
  DecryptedConnection,
  Dialect,
  MockGateway,
  RuntimeDeps,
  SankhyaRuntime,
} from './sankhya-runtime';

/** Id of the read-only connection defined by the SANKHYA_* variables (never stored). */
export const ENV_CONNECTION_ID = 'env-default';

/** What the API shows in place of a client id too short to be partially revealed. */
export const SECRET_MASK = '********';

/** Whether a secret is stored; its value is never shown. */
export type SecretState = 'SET' | 'NOT_SET';

export type ConnectionStatus = 'READY' | 'NOT_CONFIGURED' | 'DISABLED';

export interface ConnectionPublic {
  id: string;
  name: string;
  environment: Environment;
  mode: ConnectionMode;
  baseUrl: string;
  dialect: Dialect;
  enabled: boolean;
  /** `env`: defined by environment variables, read-only (it can only be tested). */
  source: 'env' | 'database';
  status: ConnectionStatus;
  /** Never the values: the client id masked as `abcd…wxyz` (or NOT_SET), the others as a state. */
  secrets: {
    clientId: string;
    clientSecret: SecretState;
    xToken: SecretState;
  };
  secretsRotatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConnectionSecrets {
  clientId: string;
  clientSecret: string;
  xToken: string;
}

export interface CreateConnectionInput {
  name: string;
  environment: Environment;
  mode: ConnectionMode;
  baseUrl: string;
  dialect: Dialect;
  enabled?: boolean;
  /** Optional: a connection without secrets is listed as NOT_CONFIGURED until they are set. */
  secrets?: Partial<ConnectionSecrets>;
}

export type UpdateConnectionInput = Partial<Omit<CreateConnectionInput, 'secrets'>>;

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
}

export interface ConnectionsOverview {
  /** NOT_CONFIGURED: no enabled connection has all of its credentials. */
  state: 'READY' | 'NOT_CONFIGURED';
  mode: ConnectionMode;
  readyConnections: number;
}

export interface ConnectionsDeps extends Omit<RuntimeDeps, 'mockGateway'> {
  /** DNS lookup for the SSRF guard (tests inject a stub). */
  resolve?: (host: string) => Promise<string[]>;
  /**
   * Starts the fictitious gateway shared by mock connections (default: `createMockSankhya()`,
   * which accepts `MOCK_CREDENTIALS`). Started on first use, closed by `close()`.
   */
  mockGateway?: () => Promise<MockGateway & { close(): Promise<void> }>;
}

type SecretField = keyof ConnectionSecrets;
const SECRET_FIELDS: SecretField[] = ['clientId', 'clientSecret', 'xToken'];
const ENC_COLUMN = {
  clientId: 'clientIdEnc',
  clientSecret: 'clientSecretEnc',
  xToken: 'xTokenEnc',
} as const satisfies Record<SecretField, keyof ConnectionRow>;

const resolveAll = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/** `abcd…wxyz` for ids long enough to stay unguessable; the plain mask otherwise. */
export function maskClientId(value: string): string {
  return value.length >= 16 ? `${value.slice(0, 4)}…${value.slice(-4)}` : SECRET_MASK;
}

/**
 * Sankhya gateway connections: the env-sourced one (read-only, secrets only in memory) plus the
 * ones registered by admins (secrets sealed at rest). Runtimes are cached per connection and
 * dropped whenever the connection or its secrets change.
 */
export class ConnectionsService {
  private readonly runtimes = new Map<string, Promise<SankhyaRuntime>>();
  private readonly resolve: (host: string) => Promise<string[]>;
  private mock?: Promise<MockGateway & { close(): Promise<void> }>;
  private readonly listeners: Array<(id: string) => unknown> = [];

  constructor(
    private readonly db: Database,
    private readonly config: AppConfig,
    private readonly deps: ConnectionsDeps = {},
  ) {
    this.resolve = deps.resolve ?? resolveAll;
  }

  /**
   * Calls `listener` after a connection is changed, has its secrets replaced or is deleted, so
   * what is cached of it elsewhere (its catalog) is dropped.
   */
  onChange(listener: (id: string) => unknown): void {
    this.listeners.push(listener);
  }

  private async changed(id: string): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(id);
      } catch {
        // A listener only drops caches; the change itself already happened.
      }
    }
  }

  async list(): Promise<ConnectionPublic[]> {
    const rows = await this.db.select().from(connections).orderBy(asc(connections.name));
    const env = this.envPublic();
    return [...(env ? [env] : []), ...rows.map((r) => this.toPublic(r))];
  }

  async get(id: string): Promise<ConnectionPublic> {
    if (id === ENV_CONNECTION_ID) {
      const env = this.envPublic();
      if (!env) throw notFound();
      return env;
    }
    return this.toPublic(await this.row(id));
  }

  async overview(): Promise<ConnectionsOverview> {
    const ready = (await this.list()).filter((c) => c.status === 'READY').length;
    return {
      state: ready > 0 ? 'READY' : 'NOT_CONFIGURED',
      mode: this.config.sankhya.mode,
      readyConnections: ready,
    };
  }

  async create(input: CreateConnectionInput): Promise<ConnectionPublic> {
    this.assertName(input.name);
    this.assertModeAllowed(input.mode);
    const baseUrl = await this.checkBaseUrl(input.mode, input.baseUrl);
    const id = randomUUID();
    const sealed = this.seal(id, input.secrets ?? {});
    const hasSecrets = Object.keys(sealed).length > 0;
    try {
      const [row] = await this.db
        .insert(connections)
        .values({
          id,
          name: input.name,
          environment: input.environment,
          mode: input.mode,
          baseUrl,
          dialect: input.dialect,
          enabled: input.enabled ?? true,
          ...sealed,
          ...(hasSecrets ? { secretsRotatedAt: new Date() } : {}),
        })
        .returning();
      return this.toPublic(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateName();
      throw err;
    }
  }

  async update(id: string, patch: UpdateConnectionInput): Promise<ConnectionPublic> {
    this.assertEditable(id);
    const current = await this.row(id);
    if (patch.name !== undefined) this.assertName(patch.name);
    const mode = patch.mode ?? current.mode;
    if (patch.mode !== undefined) this.assertModeAllowed(mode);
    const changes: Partial<ConnectionRow> = { ...patch, updatedAt: new Date() };
    if (patch.baseUrl !== undefined || patch.mode !== undefined) {
      changes.baseUrl = await this.checkBaseUrl(mode, patch.baseUrl ?? current.baseUrl);
    }
    try {
      const [row] = await this.db
        .update(connections)
        .set(changes)
        .where(eq(connections.id, id))
        .returning();
      if (!row) throw notFound();
      return this.toPublic(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw duplicateName();
      throw err;
    } finally {
      this.dropRuntime(id);
      await this.changed(id);
    }
  }

  /** Replaces some or all secrets. There is deliberately no way to read them back. */
  async rotateSecrets(id: string, secrets: Partial<ConnectionSecrets>): Promise<ConnectionPublic> {
    this.assertEditable(id);
    await this.row(id);
    const sealed = this.seal(id, secrets);
    if (Object.keys(sealed).length === 0)
      throw new AppError('VALIDATION_ERROR', 'No secret to replace');
    try {
      const now = new Date();
      const [row] = await this.db
        .update(connections)
        .set({ ...sealed, secretsRotatedAt: now, updatedAt: now })
        .where(eq(connections.id, id))
        .returning();
      if (!row) throw notFound();
      return this.toPublic(row);
    } finally {
      this.dropRuntime(id);
      await this.changed(id);
    }
  }

  async delete(id: string): Promise<void> {
    this.assertEditable(id);
    const deleted = await this.db
      .delete(connections)
      .where(eq(connections.id, id))
      .returning({ id: connections.id });
    this.dropRuntime(id);
    if (deleted.length === 0) throw notFound();
    await this.changed(id);
  }

  /** Authenticates and runs the probe query. Failures are reported, never thrown. */
  async test(id: string): Promise<ConnectionTestResult> {
    await this.get(id);
    const started = performance.now();
    const latency = () => Math.round(performance.now() - started);
    try {
      const runtime = await this.getRuntime(id);
      await runtime.client.executeQuery(
        probeSql(runtime.dialect, runtime.mode),
        AbortSignal.timeout(this.config.sankhya.timeoutMs),
      );
      return { ok: true, latencyMs: latency() };
    } catch (err) {
      return {
        ok: false,
        latencyMs: latency(),
        errorCode: isAppError(err) ? err.code : 'INTERNAL_ERROR',
      };
    }
  }

  getRuntime(id: string): Promise<SankhyaRuntime> {
    let runtime = this.runtimes.get(id);
    if (!runtime) {
      runtime = this.buildRuntime(id);
      this.runtimes.set(id, runtime);
      // A failed build (missing secrets, unsafe URL) must not stay cached.
      runtime.catch(() => {
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
      });
    }
    return runtime;
  }

  /** Drops every cached runtime and stops the mock gateway. */
  async close(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) this.dropRuntime(id);
    const mock = this.mock;
    this.mock = undefined;
    if (mock) await mock.then((m) => m.close()).catch(() => undefined);
  }

  // ---------------------------------------------------------------- internals

  private async buildRuntime(id: string): Promise<SankhyaRuntime> {
    const conn = await this.decrypted(id);
    this.assertModeAllowed(conn.mode);
    if (conn.mode === 'live') {
      // Checked again at use time: the allowlist or DNS may have changed since it was saved.
      await assertSafeGatewayUrl(conn.baseUrl, {
        allowHosts: this.config.sankhya.allowedHosts,
        resolve: this.resolve,
      });
    }
    const { resolve: _resolve, mockGateway: _mock, ...runtimeDeps } = this.deps;
    return createSankhyaRuntime(conn, this.config, {
      ...runtimeDeps,
      ...(conn.mode === 'mock' ? { mockGateway: await this.mockGateway() } : {}),
    });
  }

  private mockGateway(): Promise<MockGateway> {
    if (!this.mock) {
      const start =
        this.deps.mockGateway ?? (() => createMockSankhya(this.config.sankhya.mockGateway));
      const mock = start();
      this.mock = mock;
      // A failed start must not stay cached.
      mock.catch(() => {
        if (this.mock === mock) this.mock = undefined;
      });
    }
    return this.mock;
  }

  private async decrypted(id: string): Promise<DecryptedConnection> {
    if (id === ENV_CONNECTION_ID) {
      const env = this.config.sankhya.envConnection;
      if (!env) throw notFound();
      return { id, name: ENV_CONNECTION_ID, mode: this.config.sankhya.mode, ...env };
    }
    const row = await this.row(id);
    if (!row.enabled) throw new AppError('SANKHYA_NOT_CONFIGURED', 'The connection is disabled');
    const secrets = {} as ConnectionSecrets;
    for (const field of SECRET_FIELDS) {
      const sealed = row[ENC_COLUMN[field]];
      if (!sealed)
        throw new AppError('SANKHYA_NOT_CONFIGURED', 'The connection has no credentials yet');
      try {
        secrets[field] = decryptSecret(this.config.encryptionKey, sealed, `${id}:${field}`);
      } catch {
        // Wrong ENCRYPTION_KEY or tampered row: never fall back, never reveal which.
        throw new AppError(
          'SANKHYA_NOT_CONFIGURED',
          'The connection credentials cannot be decrypted; replace them',
        );
      }
    }
    return {
      id,
      name: row.name,
      environment: row.environment,
      mode: row.mode,
      baseUrl: row.baseUrl,
      dialect: row.dialect,
      ...secrets,
    };
  }

  private seal(id: string, secrets: Partial<ConnectionSecrets>) {
    const out: Partial<Record<(typeof ENC_COLUMN)[SecretField], string>> = {};
    for (const field of SECRET_FIELDS) {
      const value = secrets[field];
      if (value === undefined) continue;
      if (value.trim() === '') throw new AppError('VALIDATION_ERROR', `${field} must not be empty`);
      out[ENC_COLUMN[field]] = encryptSecret(this.config.encryptionKey, value, `${id}:${field}`);
    }
    return out;
  }

  private async checkBaseUrl(mode: ConnectionMode, baseUrl: string): Promise<string> {
    if (mode === 'mock' && baseUrl === MOCK_BASE_URL) return MOCK_BASE_URL;
    const allowHosts = this.config.sankhya.allowedHosts;
    // Mock connections never dial out, so they skip DNS; the host must still be allowlisted.
    const url =
      mode === 'live'
        ? await assertSafeGatewayUrl(baseUrl, { allowHosts, resolve: this.resolve })
        : assertGatewayUrlShape(baseUrl, allowHosts);
    if (url.pathname !== '/' || url.search || url.hash)
      throw new AppError('VALIDATION_ERROR', 'The gateway URL must be an origin, without a path');
    return url.origin;
  }

  /** Production never talks to a fake gateway; demo mode never talks to a real one. */
  private assertModeAllowed(mode: ConnectionMode) {
    if (mode === 'mock' && this.config.sankhya.mode === 'live')
      throw new AppError('VALIDATION_ERROR', 'Mock connections are disabled (SANKHYA_MODE=live)');
    if (mode === 'live' && this.config.demoMode)
      throw new AppError('VALIDATION_ERROR', 'Live connections are disabled in demo mode');
  }

  private assertName(name: string) {
    if (name.trim().toLowerCase() === ENV_CONNECTION_ID)
      throw new AppError('VALIDATION_ERROR', `The name ${ENV_CONNECTION_ID} is reserved`);
  }

  private assertEditable(id: string) {
    if (id === ENV_CONNECTION_ID)
      throw new AppError(
        'FORBIDDEN',
        'The connection defined by environment variables is read-only; change it in the server environment',
      );
  }

  private async row(id: string): Promise<ConnectionRow> {
    const [row] = await this.db.select().from(connections).where(eq(connections.id, id));
    if (!row) throw notFound();
    return row;
  }

  private dropRuntime(id: string) {
    const runtime = this.runtimes.get(id);
    if (!runtime) return;
    this.runtimes.delete(id);
    runtime.then(
      (r) => r.close(),
      () => undefined,
    );
  }

  private envPublic(): ConnectionPublic | undefined {
    const env = this.config.sankhya.envConnection;
    if (!env) return undefined;
    return {
      id: ENV_CONNECTION_ID,
      name: ENV_CONNECTION_ID,
      environment: env.environment,
      mode: this.config.sankhya.mode,
      baseUrl: env.baseUrl,
      dialect: env.dialect,
      enabled: true,
      source: 'env',
      status: 'READY',
      secrets: {
        clientId: maskClientId(env.clientId),
        clientSecret: 'SET',
        xToken: 'SET',
      },
      secretsRotatedAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }

  private toPublic(row: ConnectionRow): ConnectionPublic {
    const complete = SECRET_FIELDS.every((f) => row[ENC_COLUMN[f]]);
    let clientId = 'NOT_SET';
    if (row.clientIdEnc) {
      try {
        clientId = maskClientId(
          decryptSecret(this.config.encryptionKey, row.clientIdEnc, `${row.id}:clientId`),
        );
      } catch {
        clientId = SECRET_MASK;
      }
    }
    return {
      id: row.id,
      name: row.name,
      environment: row.environment,
      mode: row.mode,
      baseUrl: row.baseUrl,
      dialect: row.dialect,
      enabled: row.enabled,
      source: 'database',
      status: !row.enabled ? 'DISABLED' : complete ? 'READY' : 'NOT_CONFIGURED',
      secrets: {
        clientId,
        clientSecret: row.clientSecretEnc ? 'SET' : 'NOT_SET',
        xToken: row.xTokenEnc ? 'SET' : 'NOT_SET',
      },
      secretsRotatedAt: row.secretsRotatedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function notFound() {
  return new AppError('NOT_FOUND', 'Connection not found');
}

function duplicateName() {
  return new AppError('CONFLICT', 'A connection with this name already exists');
}
