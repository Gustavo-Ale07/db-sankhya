import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/client';
import type { Meta, SessionInfo } from '../api/types';
import type { Theme } from '../app/theme';
import { ErrorBox } from '../components/ErrorBox';
import { Footer } from '../components/Footer';

interface Props {
  meta: Meta | undefined;
  onLoggedIn: (s: SessionInfo) => void;
  theme: Theme;
  onToggleTheme: () => void;
}

export function LoginPage({ meta, onLoggedIn, theme, onToggleTheme }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLoggedIn(await api.post<SessionInfo>('/api/auth/login', { email, password }));
    } catch (err) {
      setError(err);
      setPassword('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <main className="flex flex-1 items-center justify-center p-4">
        <form
          onSubmit={(e) => void submit(e)}
          className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-panel p-6 shadow-sm"
          aria-labelledby="login-title"
        >
          <div className="flex items-start justify-between">
            <div>
              <h1 id="login-title" className="text-lg font-semibold">
                DB-Sankhya
              </h1>
              <p className="text-xs text-muted">Consultas SQL sobre o gateway do Sankhya ERP</p>
            </div>
            <button
              type="button"
              className="btn"
              onClick={onToggleTheme}
              aria-label={theme === 'dark' ? 'Usar tema claro' : 'Usar tema escuro'}
              title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
            >
              {theme === 'dark' ? '☀' : '☾'}
            </button>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-medium">E-mail</span>
            <input
              className="input w-full"
              type="email"
              name="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs font-medium">Senha</span>
            <input
              className="input w-full"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <ErrorBox error={error} />
          <button
            type="submit"
            className="btn btn-primary w-full justify-center py-1.5"
            disabled={busy}
          >
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </main>
      <Footer meta={meta} />
    </div>
  );
}
