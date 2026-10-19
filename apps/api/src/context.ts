import type { DatabaseHandle, SessionRow, UserRow } from '@dbx/database';
import type { AppConfig } from './config';
import type { AuthzService, Grants } from './services/authz';
import type { BootstrapService } from './services/bootstrap';
import type { ConnectionsService } from './services/connections';
import type { AuditService, HistoryService, SavedQueriesService } from './services/records';
import type { SessionsService } from './services/sessions';
import type { UsersService } from './services/users';
import type { ExecutionRegistry } from './services/executions';
import type { MetadataService } from './services/metadata';
import type { PolicyService } from './services/policy';
import type { ScratchManager } from './services/scratch';

export interface AppServices {
  config: AppConfig;
  database: DatabaseHandle;
  users: UsersService;
  authz: AuthzService;
  /** First administrator: one-time bootstrap token. */
  bootstrap: BootstrapService;
  sessions: SessionsService;
  audit: AuditService;
  history: HistoryService;
  saved: SavedQueriesService;
  /** Sankhya gateway connections and their cached runtimes. */
  connections: ConnectionsService;
  /** Data dictionary catalogs of the Sankhya connections. */
  metadata: MetadataService;
  /** Persisted access policy rules, validated and cached. */
  policies: PolicyService;
  /** Per-user scratch workspaces (tmp_* tables), never connected to Sankhya. */
  scratch: ScratchManager;
  /** Masks configured secrets in anything sent back to clients. */
  redact: (value: unknown) => unknown;
  executions: ExecutionRegistry;
  /** Scratch workspaces (when wired): closed on shutdown. */
  scratch?: { closeAll(): Promise<void> };
  startedAt: Date;
}

export interface AuthState {
  user: UserRow;
  session: SessionRow;
  /** Resolved on every request, so role and group changes apply immediately. */
  grants: Grants;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
  interface FastifyRequest {
    auth: AuthState | null;
  }
}
