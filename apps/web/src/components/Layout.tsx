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
import type { OpenRequest } from '../explorer/ExplorerPage';
import { HistoryPage } from '../pages/HistoryPage';
import { SavedQueriesPage } from '../pages/SavedQueriesPage';
import { ChangePasswordPage } from '../pages/ChangePasswordPage';
import { UsersPage } from '../admin/UsersPage';
import { AuditPage } from '../admin/AuditPage';
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
  { view: 'approvals', label: 'Aprovações', permission: 'APPROVAL.DECIDE' },
  { view: 'audit', label: 'Auditoria', permission: 'AUDIT.READ' },
  { view: 'status', label: 'Status' },
];

export function Layout({ theme, onToggleTheme }: { theme: Theme; onToggleTheme: () => void }) {
  const { user, meta, logout, refresh } = useSession();
  const [view, setView] = useState<View>('explorer');
  const [openRequest, setOpenRequest] = useState<OpenRequest | null>(null);
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
      <header className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1">
        <span className="mr-3 flex items-center gap-1.5 font-semibold">
          <img src="/favicon.svg" alt="" width={18} height={18} />
          DB-Sankhya
        </span>
        <nav aria-label="Navegação principal" className="flex flex-wrap gap-0.5">
          {NAV.filter((n) => allowed(n.view)).map((n) => (
            <button
              key={n.view}
              type="button"
              className={`rounded px-2.5 py-1 text-xs ${
                view === n.view ? 'bg-selected font-semibold' : 'hover:bg-hover'
              }`}
              aria-current={view === n.view ? 'page' : undefined}
              onClick={() => setView(n.view)}
            >
              {n.label}
            </button>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 text-xs">
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
          <span className="text-muted" data-testid="current-user">
            {user.name} · {rolesLabel(user.roles)}
          </span>
          <button
            type="button"
            className="btn"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
            title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button type="button" className="btn" onClick={() => setView('password')}>
            Senha
          </button>
          <button type="button" className="btn" onClick={() => void logout()}>
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
            {view === 'approvals' && allowed('approvals') && <ApprovalsPage />}
            {view === 'audit' && allowed('audit') && <AuditPage />}
            {view === 'status' && <StatusPage />}
            {view === 'password' && <ChangePasswordPage onDone={refresh} />}
          </div>
        )}
      </main>
      <Footer meta={meta} />
    </div>
  );
}
