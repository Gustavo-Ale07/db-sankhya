import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { GlobalWriteState } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { describeSecurity } from './logic';

const TONE = {
  ok: 'border-ok/50 text-ok',
  warn: 'border-warn/60 text-warn',
  danger: 'border-danger/50 text-danger',
} as const;

const onOff = (v: boolean) => (v ? 'LIGADO' : 'DESLIGADO');

export function SecurityPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const state = useQuery({
    queryKey: ['admin-security'],
    queryFn: () => api.get<{ globalWriteEnabled: GlobalWriteState }>('/api/admin/security'),
  });
  const s = state.data?.globalWriteEnabled;
  const view = s ? describeSecurity(s) : null;

  async function setRuntime(enabled: boolean) {
    const verb = enabled ? 'religar' : 'desligar';
    if (!window.confirm(`Confirma ${verb} a chave global de gravação em tempo de execução?`))
      return;
    setBusy(true);
    setError(null);
    try {
      await api.put('/api/admin/security', { globalWriteEnabled: enabled });
      await qc.invalidateQueries({ queryKey: ['admin-security'] });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3 p-4">
      <h1 className="text-base font-semibold">Segurança</h1>
      <p className="text-xs text-muted">
        Chave de emergência das gravações no ERP. O valor efetivo é o do ambiente E o da chave em
        tempo de execução: a chave só consegue desligar as gravações, nunca ligá-las contra o
        ambiente do servidor.
      </p>
      <ErrorBox error={error ?? state.error} />
      {s && view && (
        <section className="space-y-3 rounded border border-line bg-panel p-3 text-xs">
          <dl className="grid grid-cols-3 gap-3">
            <div>
              <dt className="text-muted">Ambiente (GLOBAL_WRITE_ENABLED)</dt>
              <dd className="font-semibold" data-testid="security-env">
                {onOff(s.env)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Chave em tempo de execução</dt>
              <dd className="font-semibold" data-testid="security-runtime">
                {onOff(s.runtime)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Efetivo</dt>
              <dd className="font-semibold" data-testid="security-effective">
                {onOff(s.effective)}
              </dd>
            </div>
          </dl>
          <div
            role="status"
            className={`rounded border px-3 py-2 ${TONE[view.tone]}`}
            data-testid="security-summary"
          >
            <div className="font-semibold">{view.summary}</div>
            {view.note && <div className="mt-1 text-fg/80">{view.note}</div>}
          </div>
          <div className="flex gap-2">
            {s.runtime ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void setRuntime(false)}
              >
                Desligar gravações (chave de emergência)
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || !view.canEnable}
                title={
                  view.canEnable
                    ? undefined
                    : 'O ambiente do servidor mantém as gravações desligadas'
                }
                onClick={() => void setRuntime(true)}
              >
                Religar chave de gravação
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
