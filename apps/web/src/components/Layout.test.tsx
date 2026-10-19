import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../api/client';
import type { ConnectionOption, Meta, User } from '../api/types';
import { SessionContext } from '../app/session';
import { Layout } from './Layout';

// The pages are not under test; stubbing them keeps Monaco and data fetching out of jsdom.
vi.mock('../explorer/ExplorerPage', () => ({ ExplorerPage: () => null }));
vi.mock('../pages/HistoryPage', () => ({ HistoryPage: () => null }));
vi.mock('../pages/SavedQueriesPage', () => ({ SavedQueriesPage: () => null }));
vi.mock('../pages/ChangePasswordPage', () => ({ ChangePasswordPage: () => null }));
vi.mock('../admin/UsersPage', () => ({ UsersPage: () => null }));
vi.mock('../admin/AuditPage', () => ({ AuditPage: () => null }));
vi.mock('../admin/StatusPage', () => ({ StatusPage: () => null }));

vi.mock('../api/client', () => ({ api: { get: vi.fn() } }));

const USER: User = {
  id: 'u1',
  email: 'viewer@example.com',
  name: 'Pessoa Exemplo',
  roles: ['VIEWER'],
  permissions: ['QUERY.SELECT', 'TEMP.CREATE', 'TEMP.WRITE', 'TEMP.DROP', 'TEMP.MATERIALIZE'],
  active: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};
const META: Meta = {
  name: 'DB-Sankhya',
  version: '0.1.0',
  commit: 'unknown',
  sankhyaMode: 'mock',
  demoMode: false,
};

function renderLayout(meta: Meta | undefined, user: User = USER) {
  const noop = () => Promise.resolve();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user, meta, logout: noop, refresh: noop }}>
        <Layout theme="light" onToggleTheme={() => undefined} />
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

const CONNECTIONS: ConnectionOption[] = [
  { id: 'env-default', name: 'env-default', environment: 'SANDBOX' },
  { id: 'prod', name: 'Principal', environment: 'PRODUCTION' },
];

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.get).mockResolvedValue({ items: CONNECTIONS });
});

afterEach(cleanup);

describe('Layout demo banner', () => {
  it('shows the DEMO banner when the API reports demo mode', () => {
    renderLayout({ ...META, demoMode: true });
    const banner = screen.getByTestId('demo-banner');
    expect(banner.textContent).toContain('DEMO — dados fictícios');
  });

  it('has no banner outside demo mode', () => {
    renderLayout(META);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
    renderLayout(undefined);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});

describe('Layout environment banner and connection picker', () => {
  it('shows the banner of the first connection, then of the selected one', async () => {
    renderLayout(META);
    expect((await screen.findByTestId('environment-label')).textContent).toBe('SANDBOX');
    fireEvent.change(screen.getByTestId('connection-picker'), { target: { value: 'prod' } });
    expect((await screen.findByTestId('environment-label')).textContent).toBe('PRODUÇÃO');
    expect(window.localStorage.getItem('dbx.connection')).toBe('prod');
  });

  it('remembers the selection across loads', async () => {
    window.localStorage.setItem('dbx.connection', 'prod');
    renderLayout(META);
    expect((await screen.findByTestId('environment-label')).textContent).toBe('PRODUÇÃO');
  });

  it('has no picker, no request and no banner without QUERY.SELECT', () => {
    renderLayout(META, { ...USER, permissions: [] });
    expect(screen.queryByTestId('connection-picker')).toBeNull();
    expect(screen.queryByTestId('environment-banner')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });
});

describe('Layout navigation gating', () => {
  const navLabels = () =>
    Array.from(
      screen.getByRole('navigation', { name: 'Navegação principal' }).querySelectorAll('button'),
      (b) => b.textContent,
    );

  it('hides administration pages from a user without the permissions', () => {
    renderLayout(META);
    expect(navLabels()).not.toContain('Usuários');
    expect(navLabels()).not.toContain('Auditoria');
    expect(screen.getByTestId('current-user').textContent).toContain('Leitor');
  });

  it('shows each page for its own permission, not for a role name', () => {
    renderLayout(META, { ...USER, roles: ['CUSTOM'], permissions: ['AUDIT.READ'] });
    expect(navLabels()).toContain('Auditoria');
    expect(navLabels()).not.toContain('Usuários');
    expect(screen.getByTestId('current-user').textContent).toContain('CUSTOM');
    cleanup();
    renderLayout(META, { ...USER, roles: ['ADMIN'], permissions: ['ADMIN.USERS', 'AUDIT.READ'] });
    expect(navLabels()).toEqual(expect.arrayContaining(['Usuários', 'Auditoria']));
  });
});
