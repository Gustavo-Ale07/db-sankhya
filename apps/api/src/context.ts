import type { DatabaseHandle, SessionRow, UserRow } from '@dbx/database';
import type { AppConfig } from './config';
import type { AuthzService, Grants } from './services/authz';
import type { ConnectionsService } from './services/connections';
import type { AuditService, HistoryService, SavedQueriesService } from './services/records';
import type { SessionsService } from './services/sessions';
import type { UsersService } from './services/users';
import type { ExecutionRegistry } from './services/executions';
import type { MetadataService } from './services/metadata';

export interface AppServices {
  config: AppConfig;
  database: DatabaseHandle;
  users: UsersService;
  authz: AuthzService;
  sessions: SessionsService;
  audit: AuditService;
  history: HistoryService;
  saved: SavedQueriesService;
  /** Sankhya gateway connections and their cached runtimes. */
  connections: ConnectionsService;
  /** Data dictionary catalogs of the Sankhya connections. */
  metadata: MetadataService;
  /** Masks configured secrets in anything sent back to clients. */
  redact: (value: unknown) => unknown;
  executions: ExecutionRegistry;
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
