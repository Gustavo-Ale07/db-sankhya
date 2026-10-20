import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { SessionInfo } from '../api/types';
import { App } from './App';

// The signed-in shell is not under test; stubbing it keeps the pages and Monaco out of jsdom.
vi.mock('../components/Layout', async () => {
  const { useSession } = await import('./session');
  return {
    Layout: () => {
      const { logout } = useSession();
      return (
        <button type="button" onClick={() => void logout()}>
          shell
        </button>
      );
    },
  };
});

const SESSION = {
  user: {
    id: 'u1',
    email: 'viewer@example.com',
    name: 'Pessoa Exemplo',
    roles: ['VIEWER'],
    permissions: ['QUERY.SELECT'],
    active: true,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
} as unknown as SessionInfo;

const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
const unauthenticated = () =>
  json(401, { error: { code: 'AUTH_REQUIRED', message: 'Sign in required' } });
const META = { name: 'DB-Sankhya', version: '0.1.0' };

/** Serves `/api/meta`, and `/api/auth/me` from `me()`. */
function serve(me: () => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => (String(url).startsWith('/api/auth/me') ? me() : json(200, META))),
  );
}

function mount(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  );
  return qc;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('shows the login form when there is no session on first load (401)', async () => {
    serve(unauthenticated);
    mount();
    expect(await screen.findByLabelText('E-mail', {}, { timeout: 2000 })).toBeDefined();
    expect(screen.queryByText('Carregando…')).toBeNull();
  });

  it('signs out and drops per-user data when the session expires', async () => {
    serve(() => json(200, SESSION));
    const qc = mount();
    expect(await screen.findByText('shell')).toBeDefined();
    qc.setQueryData(['schema', 'env-default'], { connectionId: 'env-default', catalog: {} });

    // The next call answers 401: the shell goes back to the login form, with nothing cached.
    serve(unauthenticated);
    await act(() => qc.invalidateQueries({ queryKey: ['me'] }));
    expect(await screen.findByLabelText('E-mail')).toBeDefined();
    expect(qc.getQueryData(['schema', 'env-default'])).toBeUndefined();
  });

  it('logs out to the login form, with nothing cached', async () => {
    serve(() => json(200, SESSION));
    const qc = mount();
    const shell = await screen.findByText('shell');
    qc.setQueryData(['schema', 'env-default'], { connectionId: 'env-default', catalog: {} });
    fireEvent.click(shell);
    expect(await screen.findByLabelText('E-mail')).toBeDefined();
    await waitFor(() => expect(qc.getQueryData(['schema', 'env-default'])).toBeUndefined());
    expect(qc.getQueryData(['me'])).toBeNull();
  });
});
