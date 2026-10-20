import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Theme } from '../app/theme';
import { can, rolesLabel, useSession } from '../app/session';
import {
  loadSelectedConnection,
  resolveConnection,
  saveSelectedConnection,
} from '../app/connection';
import { api } from '../api/client';
import type { ConnectionOption, Permission } from '../api/types';
import { ConnectionPicker } from '../explorer/ConnectionPicker';
import { EnvironmentBanner } from './EnvironmentBanner';
import { ExplorerPage } from '../explorer/ExplorerPage';
import type { OpenPlanRequest, OpenRequest } from '../explorer/ExplorerPage';
import type { PreparedPlan } from '../api/mutations';
import { HistoryPage } from '../pages/HistoryPage';
import { SavedQueriesPage } from '../pages/SavedQueriesPage';
import { ChangePasswordPage } from '../pages/ChangePasswordPage';
import { UsersPage } from '../admin/UsersPage';
import { AuditPage } from '../admin/AuditPage';
import { GroupsPage } from '../admin/GroupsPage';
import { RolesPage } from '../admin/RolesPage';
import { PoliciesPage } from '../admin/PoliciesPage';
import { ConnectionsPage } from '../admin/ConnectionsPage';
import { SecurityPage } from '../admin/SecurityPage';
import { ApprovalsPage } from '../admin/ApprovalsPage';
import { StatusPage } from '../admin/StatusPage';
import { ScratchPage } from '../scratch/ScratchPage';
import { Footer } from './Footer';

export type View =
  | 'explorer'
  | 'history'
  | 'saved'
  | 'scratch'
  | 'users'
  | 'groups'
  | 'roles'
  | 'policies'
  | 'connections'
  | 'security'
  | 'approvals'
  | 'audit'
  | 'status'
  | 'password';

const NAV: { view: View; label: string; permission?: Permission }[] = [
  { view: 'explorer', label: 'Editor SQL' },
  { view: 'history', label: 'Histórico' },
  { view: 'saved', label: 'Consultas salvas' },
  { view: 'scratch', label: 'Scratch', permission: 'QUERY.SELECT' },
  { view: 'users', label: 'Usuários', permission: 'ADMIN.USERS' },
  { view: 'groups', label: 'Grupos', permission: 'ADMIN.GROUPS' },
  { view: 'roles', label: 'Papéis', permission: 'ADMIN.ROLES' },
  { view: 'policies', label: 'Políticas', permission: 'ADMIN.POLICIES' },
  { view: 'connections', label: 'Conexões', permission: 'ADMIN.CONNECTIONS' },
  { view: 'security', label: 'Segurança', permission: 'ADMIN.SECURITY' },
  { view: 'approvals', label: 'Aprovações', permission: 'APPROVAL.DECIDE' },
  { view: 'audit', label: 'Auditoria', permission: 'AUDIT.READ' },
  { view: 'status', label: 'Status' },
];

export function Layout({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { user, meta, logout, refresh } = useSession();
  const [view, setView] = useState<View>('explorer');
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
  // The server-prepared rollback plan; its token stays in memory only.
  const [planRequest, setPlanRequest] = useState<OpenPlanRequest | null>(null);
  const canQuery = can(user, 'QUERY.SELECT');
  const [wantedConnection, setWantedConnection] = useState(loadSelectedConnection);
  const connectionList = useQuery({
    queryKey: ['connections'],
    queryFn: () => api.get<{ items: ConnectionOption[] }>('/api/connections'),
    enabled: canQuery,
    staleTime: 60_000,
  });
  const connection = resolveConnection(connectionList.data?.items, wantedConnection);
  const selectConnection = useCallback((id: string) => {
    setWantedConnection(id);
    saveSelectedConnection(id);
  }, []);

  const openInEditor = useCallback((req: Omit<OpenRequest, 'nonce'>) => {
    setOpenRequest({ ...req, nonce: Date.now() + Math.random() });
    setView('explorer');
  }, []);

  // A rollback opens on the audit event's own connection, exactly: never on a fallback, and
  // without changing the remembered default (the selection is not persisted).
  const connectionItems = connectionList.data?.items;
  const openRollback = useCallback(
    (req: { plan: PreparedPlan; sql: string; title: string }, connectionId: string) => {
      if (!connectionItems?.some((c) => c.id === connectionId)) return;
      setWantedConnection(connectionId);
      setPlanRequest({ ...req, connectionId, nonce: Date.now() + Math.random() });
      setView('explorer');
    },
    [connectionItems],
  );

  const allowed = (v: View) => {
    const permission = NAV.find((n) => n.view === v)?.permission;
    return !permission || can(user, permission);
  };
  return (
    <div className="flex h-full flex-col">
      {meta?.demoMode && (
        <div
          role="note"
          data-testid="demo-banner"
          className="border-b border-warn/60 bg-panel px-3 py-1 text-center text-xs font-semibold text-warn"
        >
          DEMO — dados fictícios
        </div>
      )}
      <EnvironmentBanner environment={connection?.environment} connectionName={connection?.name} />
      <header className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-line bg-panel px-2 py-0.5">
        <span className="mr-2 flex shrink-0 items-center gap-1.5 font-semibold">
          <img src="/favicon.svg" alt="" width={16} height={16} />
          DB-Sankhya
        </span>
        <nav aria-label="Navegação principal" className="flex min-w-0 flex-wrap gap-px">
          {NAV.filter((n) => allowed(n.view)).map((n) => (
            <button
              key={n.view}
              type="button"
              className={`rounded px-2 py-0.5 text-xs ${
                view === n.view ? 'bg-selected font-semibold' : 'hover:bg-hover'
              }`}
              aria-current={view === n.view ? 'page' : undefined}
              onClick={() => setView(n.view)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 text-xs">
          {canQuery && (
            <ConnectionPicker
              connections={connectionList.data?.items ?? []}
              selectedId={connection?.id}
              onSelect={selectConnection}
              loading={connectionList.isPending}
            />
          )}
          {meta?.sankhyaMode === 'mock' && (
            <span className="badge border-ok/50 text-ok" title="Dados fictícios em memória">
              MOCK
            </span>
          )}
          {meta?.sankhyaMode === 'live' && (
            <span className="badge border-warn/60 text-warn" title="Conectado ao Sankhya real">
              LIVE
            </span>
          )}
          <span className="max-w-64 truncate text-muted" data-testid="current-user">
            {user.name} · {rolesLabel(user.roles)}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setView('password')}>
            Senha
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void logout()}>
            Sair
          </button>
        </div>
      </header>

      <main className="relative min-h-0 flex-1">
        {/* The editor stays mounted so tabs, results and Monaco state survive navigation. */}
        <div className={view === 'explorer' ? 'h-full' : 'hidden'}>
          <ExplorerPage
            theme={theme}
            openRequest={openRequest}
            planRequest={planRequest}
            active={view === 'explorer'}
            connectionId={connection?.id}
            connectionReady={!canQuery || !connectionList.isPending}
          />
        </div>
        {view !== 'explorer' && (
          <div className="h-full overflow-auto">
            {view === 'history' && <HistoryPage onOpen={openInEditor} />}
            {view === 'saved' && <SavedQueriesPage onOpen={openInEditor} />}
            {view === 'scratch' && allowed('scratch') && (
              <ScratchPage connectionId={connection?.id} connectionName={connection?.name} />
            )}
            {view === 'users' && allowed('users') && <UsersPage />}
            {view === 'groups' && allowed('groups') && <GroupsPage />}
            {view === 'roles' && allowed('roles') && <RolesPage />}
            {view === 'policies' && allowed('policies') && <PoliciesPage />}
            {view === 'connections' && allowed('connections') && <ConnectionsPage />}
            {view === 'security' && allowed('security') && <SecurityPage />}
            {view === 'approvals' && allowed('approvals') && <ApprovalsPage />}
            {view === 'audit' && allowed('audit') && (
              <AuditPage onOpen={openRollback} connections={connectionItems} />
            )}
            {view === 'status' && <StatusPage />}
            {view === 'password' && <ChangePasswordPage onDone={refresh} />}
          </div>
        )}
      </main>
      <Footer meta={meta} />
    </div>
  );
}
