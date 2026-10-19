import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, onAuthError } from '../api/client';
import type { Meta, SessionInfo } from '../api/types';
import { LoginPage } from '../pages/LoginPage';
import { ChangePasswordPage } from '../pages/ChangePasswordPage';
import { Layout } from '../components/Layout';
import { SessionContext } from './session';
import { useTheme } from './theme';
import { clearSavedTabs } from '../explorer/tabs';

export function App() {
  const qc = useQueryClient();
  const [theme, toggleTheme] = useTheme();

  const meta = useQuery({
    queryKey: ['meta'],
    queryFn: () => api.get<Meta>('/api/meta'),
    staleTime: Infinity,
  });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.get<SessionInfo>('/api/auth/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });

  useEffect(
    () =>
      onAuthError((err) => {
        if (err.code === 'PASSWORD_CHANGE_REQUIRED')
          void qc.invalidateQueries({ queryKey: ['me'] });
        else qc.setQueryData(['me'], null);
      }),
    [qc],
  );

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const logout = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      // The session is dropped locally either way.
    } finally {
      clearSavedTabs();
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  const session = me.data;
  const ctx = useMemo(
    () => (session ? { user: session.user, meta: meta.data, logout, refresh } : null),
    [session, meta.data, logout, refresh],
  );

  if (me.isPending) {
    return (
      <div className="flex h-full items-center justify-center text-muted" role="status">
        Carregando…
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" role="alert">
        <p>Não foi possível contatar o servidor.</p>
        <button className="btn" onClick={() => void me.refetch()}>
          Tentar novamente
        </button>
      </div>
    );
  }
  if (!session || !ctx) {
    return (
      <LoginPage
        meta={meta.data}
        onLoggedIn={(s) => qc.setQueryData(['me'], s)}
        theme={theme}
        onToggleTheme={toggleTheme}
      />
    );
  }
  return (
    <SessionContext.Provider value={ctx}>
      {session.user.mustChangePassword ? (
        <ChangePasswordPage forced onDone={refresh} onLogout={logout} />
      ) : (
        <Layout theme={theme} onToggleTheme={toggleTheme} />
      )}
    </SessionContext.Provider>
  );
}
