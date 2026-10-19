import { useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api/client';
import { ErrorBox } from '../components/ErrorBox';
import { passwordProblems } from '../lib/password';

interface Props {
  forced?: boolean;
  onDone: () => void | Promise<void>;
  onLogout?: () => void | Promise<void>;
}

export function ChangePasswordPage({ forced = false, onDone, onLogout }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    const problems = passwordProblems(next);
    if (problems.length > 0) {
      setLocalError(`A nova senha precisa de: ${problems.join(', ')}.`);
      return;
    }
    if (next !== confirm) {
      setLocalError('A confirmação não confere com a nova senha.');
      return;
    }
    if (next === current) {
      setLocalError('A nova senha deve ser diferente da atual.');
      return;
    }
    setLocalError(null);
    setBusy(true);
    try {
      await api.post('/api/auth/change-password', { currentPassword: current, newPassword: next });
      setDone(true);
      setCurrent('');
      setNext('');
      setConfirm('');
      await onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form
      onSubmit={(e) => void submit(e)}
      className="w-full max-w-sm space-y-3 rounded-lg border border-line bg-panel p-6 shadow-sm"
      aria-labelledby="pw-title"
    >
      <h1 id="pw-title" className="text-lg font-semibold">
        {forced ? 'Defina uma nova senha' : 'Alterar senha'}
      </h1>
      {forced && (
        <p className="text-xs text-muted">
          Sua senha atual é provisória. Escolha uma senha pessoal para continuar.
        </p>
      )}
      <label className="block space-y-1">
        <span className="text-xs font-medium">Senha atual</span>
        <input
          className="input w-full"
          type="password"
          name="currentPassword"
          autoComplete="current-password"
          required
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </label>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Nova senha</span>
        <input
          className="input w-full"
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          value={next}
          onChange={(e) => setNext(e.target.value)}
          aria-describedby="pw-hint"
        />
      </label>
      <p id="pw-hint" className="-mt-2 text-[11px] text-muted">
        Mínimo de 12 caracteres, misturando maiúsculas, minúsculas, números e símbolos.
      </p>
      <label className="block space-y-1">
        <span className="text-xs font-medium">Confirmar nova senha</span>
        <input
          className="input w-full"
          type="password"
          name="confirmPassword"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </label>
      {localError && (
        <div role="alert" className="text-xs text-danger">
          {localError}
        </div>
      )}
      <ErrorBox error={error} />
      {done && !forced && (
        <div role="status" className="text-xs text-ok">
          Senha alterada. As demais sessões foram encerradas.
        </div>
      )}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary flex-1 justify-center" disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar nova senha'}
        </button>
        {onLogout && (
          <button type="button" className="btn" onClick={() => void onLogout()}>
            Sair
          </button>
        )}
      </div>
    </form>
  );

  return forced ? (
    <div className="flex h-full items-center justify-center p-4">{form}</div>
  ) : (
    <div className="p-4">{form}</div>
  );
}
