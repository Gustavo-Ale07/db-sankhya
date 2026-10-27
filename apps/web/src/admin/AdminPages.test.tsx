import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import type { AdminConnection, AdminUser, Permission, RoleInfo, User } from '../api/types';
import { SessionContext } from '../app/session';
import { ConnectionsPage, typedSecrets } from './ConnectionsPage';
import { PoliciesPage } from './PoliciesPage';
import { SecurityPage } from './SecurityPage';
import { UsersPage } from './UsersPage';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}));

const ME: User = {
  id: 'me',
  email: 'admin@example.com',
  name: 'Admin Exemplo',
  roles: ['ADMIN'],
  permissions: ['ADMIN.CONNECTIONS', 'ADMIN.POLICIES', 'ADMIN.SECURITY'] as Permission[],
  active: true,
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function renderPage(ui: React.ReactElement, user: User = ME) {
  const noop = () => Promise.resolve();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionContext.Provider value={{ user, meta: undefined, logout: noop, refresh: noop }}>
        {ui}
      </SessionContext.Provider>
    </QueryClientProvider>,
  );
}

// jsdom does not implement <dialog> modality.
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

/** The modals of a page are all mounted; the open one carries the `open` attribute. */
const openDialog = () => document.querySelector<HTMLElement>('dialog[open]')!;

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const conn = (over: Partial<AdminConnection> = {}): AdminConnection => ({
  id: 'c1',
  name: 'Homolog',
  environment: 'HOMOLOGATION',
  mode: 'live',
  baseUrl: 'https://sankhya.example.com',
  dialect: 'oracle',
  enabled: true,
  source: 'database',
  editable: true,
  status: 'READY',
  secrets: { clientId: 'abcd…wxyz', clientSecret: 'SET', xToken: 'NOT_SET' },
  secretsRotatedAt: null,
  createdAt: null,
  updatedAt: null,
  ...over,
});

describe('typedSecrets', () => {
  it('keeps only the typed fields', () => {
    expect(typedSecrets({ clientId: '', clientSecret: 'novo', xToken: '' })).toEqual({
      clientSecret: 'novo',
    });
  });
});

describe('ConnectionsPage', () => {
  it('masks secrets, shows the environment text and tests a connection', async () => {
    vi.mocked(api.get).mockResolvedValue({
      items: [conn(), conn({ id: 'env', name: 'Padrão', source: 'env', editable: false })],
    });
    vi.mocked(api.post).mockResolvedValue({
      ok: false,
      latencyMs: 12,
      errorCode: 'SANKHYA_AUTH_ERROR',
    });
    renderPage(<ConnectionsPage />);
    const items = await screen.findAllByTestId('connection-item');
    expect(items).toHaveLength(2);
    expect(screen.getAllByTestId('connection-environment')[0]!.textContent).toBe('HOMOLOGAÇÃO');
    const secret = screen.getByTestId('secret-c1-clientSecret');
    expect(secret.textContent).toContain('••••');
    expect(secret.textContent).toContain('definido');
    expect(screen.getByTestId('secret-c1-xToken').textContent).toBe('não definido');
    // The read-only connection offers only "Testar".
    expect(within(items[1]!).queryByRole('button', { name: 'Editar' })).toBeNull();
    expect(within(items[1]!).queryByRole('button', { name: 'Rotacionar segredos' })).toBeNull();

    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Testar' }));
    expect((await screen.findByTestId('test-result-c1')).textContent).toContain(
      'SANKHYA_AUTH_ERROR',
    );
    expect(api.post).toHaveBeenCalledWith('/api/admin/connections/c1/test');
  });

  it('rotates only the typed secrets', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [conn()] });
    vi.mocked(api.put).mockResolvedValue({ item: conn() });
    renderPage(<ConnectionsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rotacionar segredos' }));
    const dialog = openDialog();
    const replace = within(dialog).getByRole('button', { name: 'Substituir', hidden: true });
    expect((replace as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Client secret/, { selector: 'input' }), {
      target: { value: 'novo-segredo' },
    });
    fireEvent.click(replace);
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/admin/connections/c1/secrets', {
        clientSecret: 'novo-segredo',
      }),
    );
  });
});

describe('PoliciesPage', () => {
  it('shows the policy version and renders server validation errors', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [], policyVersion: 'a'.repeat(64), invalid: [] });
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(400, { code: 'VALIDATION_ERROR', message: 'invalid rule: unknown action FOO' }),
    );
    renderPage(<PoliciesPage />);
    expect((await screen.findByTestId('policy-version')).textContent).toContain('aaaaaaaaaaaa');
    fireEvent.click(screen.getByRole('button', { name: 'Nova política' }));
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Nome'), { target: { value: 'Regra X' } });
    fireEvent.click(within(dialog).getByLabelText('QUERY.SELECT'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar', hidden: true }));
    expect(await within(dialog).findByText(/unknown action FOO/)).toBeTruthy();
  });

  it('offers the five SERVER.* actions in the rule editor and sends them on save', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [], policyVersion: 'c'.repeat(64), invalid: [] });
    vi.mocked(api.post).mockResolvedValue({ item: {}, policyVersion: 'd'.repeat(64) });
    renderPage(<PoliciesPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nova política' }));
    const dialog = openDialog();
    fireEvent.change(within(dialog).getByLabelText('Nome'), { target: { value: 'Servidor' } });
    const server = ['SERVER.DDL', 'SERVER.DELETE', 'SERVER.DML_RAW', 'SERVER.DCL', 'SERVER.PLSQL'];
    for (const a of server) fireEvent.click(within(dialog).getByLabelText(a));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Salvar', hidden: true }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/api/admin/policies',
        expect.objectContaining({ actions: server }),
      ),
    );
  });

  it('warns when stored enabled rules are invalid', async () => {
    vi.mocked(api.get).mockResolvedValue({
      items: [],
      policyVersion: 'b'.repeat(64),
      invalid: ['invalid rule x: bad'],
    });
    renderPage(<PoliciesPage />);
    expect(await screen.findByText(/invalid rule x: bad/)).toBeTruthy();
  });
});

describe('SecurityPage', () => {
  it('shows env, runtime and effective and blocks enabling while env is off', async () => {
    vi.mocked(api.get).mockResolvedValue({
      globalWriteEnabled: { env: false, runtime: false, effective: false },
    });
    renderPage(<SecurityPage />);
    expect((await screen.findByTestId('security-env')).textContent).toBe('DESLIGADO');
    expect(screen.getByTestId('security-runtime').textContent).toBe('DESLIGADO');
    expect(screen.getByTestId('security-effective').textContent).toBe('DESLIGADO');
    expect(screen.getByTestId('security-summary').textContent).toContain('GLOBAL_WRITE_ENABLED');
    const enable = screen.getByRole('button', { name: 'Religar chave de gravação' });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns the runtime switch off after confirmation', async () => {
    vi.mocked(api.get).mockResolvedValue({
      globalWriteEnabled: { env: true, runtime: true, effective: true },
    });
    vi.mocked(api.put).mockResolvedValue({});
    renderPage(<SecurityPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Desligar gravações/ }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/admin/security', { globalWriteEnabled: false }),
    );
  });
});

describe('UsersPage', () => {
  const ROLE_ADMIN: User = {
    ...ME,
    permissions: ['QUERY.SELECT', 'ADMIN.USERS', 'ADMIN.ROLES', 'ADMIN.POLICIES'] as Permission[],
  };
  const person = (over: Partial<AdminUser>): AdminUser => ({
    ...ME,
    id: 'u1',
    email: 'homolog@example.com',
    name: 'Homolog',
    roles: ['VIEWER'],
    permissions: ['QUERY.SELECT'] as Permission[],
    directRoles: ['VIEWER'],
    groupIds: [],
    ...over,
  });
  const role = (key: string, permissions: string[]): RoleInfo => ({
    id: key,
    key,
    name: key,
    description: null,
    system: true,
    permissions: permissions as Permission[],
  });
  const mockLists = (users: AdminUser[]) =>
    vi.mocked(api.get).mockImplementation(
      (url: string) =>
        Promise.resolve(
          url === '/api/admin/roles'
            ? {
                items: [
                  role('VIEWER', ['QUERY.SELECT']),
                  role('OPERATOR', ['QUERY.SELECT', 'DATA.INSERT', 'DATA.UPDATE']),
                  role('APPROVER', ['QUERY.SELECT', 'APPROVAL.DECIDE']),
                ],
              }
            : { items: users },
        ) as never,
    );
  const operatorBox = async (email: string) => {
    fireEvent.click(
      within(screen.getByTestId(`roles-${email}`).closest('tr')!).getByRole('button', {
        name: 'Papéis',
      }),
    );
    await waitFor(() => expect(openDialog()).toBeTruthy());
    return within(openDialog()).getByRole('checkbox', { name: /Operador/ }) as HTMLInputElement;
  };

  it('lets a role administrator give another user Operador, which they do not hold', async () => {
    mockLists([person({})]);
    vi.mocked(api.put).mockResolvedValue({ item: person({}) });
    renderPage(<UsersPage />, ROLE_ADMIN);
    await screen.findByTestId('roles-homolog@example.com');
    const box = await operatorBox('homolog@example.com');
    await waitFor(() => expect(box.disabled).toBe(false));
    // Only the separated writes are handed on: an administrative permission stays out of reach.
    const auditor = within(openDialog()).getByRole('checkbox', {
      name: /APPROVER/,
    }) as HTMLInputElement;
    expect(auditor.disabled).toBe(true);
    fireEvent.click(box);
    fireEvent.click(within(openDialog()).getByRole('button', { name: 'Salvar papéis' }));
    await waitFor(() =>
      expect(api.put).toHaveBeenCalledWith('/api/admin/users/u1/roles', {
        roles: ['VIEWER', 'OPERATOR'],
      }),
    );
  });

  it('keeps Operador off while the user has not chosen their own password, and on oneself', async () => {
    mockLists([
      person({ mustChangePassword: true }),
      person({ id: ME.id, email: ME.email, name: ME.name }),
    ]);
    renderPage(<UsersPage />, ROLE_ADMIN);
    await screen.findByTestId('roles-homolog@example.com');
    const box = await operatorBox('homolog@example.com');
    await waitFor(() =>
      expect(within(openDialog()).getByText(/definir a própria senha/)).toBeTruthy(),
    );
    expect(box.disabled).toBe(true);
    const own = within(screen.getByTestId(`roles-${ME.email}`).closest('tr')!).getByRole('button', {
      name: 'Papéis',
    }) as HTMLButtonElement;
    expect(own.disabled).toBe(true);
  });
});
