import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { Meta, User } from '../api/types';
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
  return render(
    <SessionContext.Provider value={{ user, meta, logout: noop, refresh: noop }}>
      <Layout theme="light" onToggleTheme={() => undefined} />
    </SessionContext.Provider>,
  );
}

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
