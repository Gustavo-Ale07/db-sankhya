import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { translateCode } from '../api/errors';
import type { AdminConnection, ConnectionEnvironment } from '../api/types';
import { ENVIRONMENT_LABEL } from '../components/EnvironmentBanner';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { formatDateTime } from '../lib/format';
import { ENVIRONMENT_OPTIONS } from './logic';

type SecretField = 'clientId' | 'clientSecret' | 'xToken';
const SECRET_FIELDS: { key: SecretField; label: string }[] = [
  { key: 'clientId', label: 'Client ID' },
  { key: 'clientSecret', label: 'Client secret' },
  { key: 'xToken', label: 'X-Token' },
];
type Secrets = Record<SecretField, string>;
const NO_SECRETS: Secrets = { clientId: '', clientSecret: '', xToken: '' };

/** Only the secrets the admin actually typed: blank fields keep their stored value. */
export function typedSecrets(s: Secrets): Partial<Secrets> {
  const out: Partial<Secrets> = {};
  for (const { key } of SECRET_FIELDS) if (s[key]) out[key] = s[key];
  return out;
}

const STATUS_LABEL: Record<AdminConnection['status'], string> = {
  READY: 'pronta',
  NOT_CONFIGURED: 'sem credenciais',
  DISABLED: 'desabilitada',
};

interface Form {
  id: string | null;
  name: string;
  environment: ConnectionEnvironment;
  mode: 'live' | 'mock';
  baseUrl: string;
  dialect: 'oracle' | 'mssql';
  enabled: boolean;
  secrets: Secrets;
}

const EMPTY: Form = {
  id: null,
  name: '',
  environment: 'SANDBOX',
  mode: 'mock',
  baseUrl: '',
  dialect: 'oracle',
  enabled: true,
  secrets: NO_SECRETS,
};

interface TestResult {
  ok: boolean;
  latencyMs: number;
  errorCode?: string;
}

function SecretState({ value }: { value: 'SET' | 'NOT_SET' }) {
  return value === 'SET' ? (
    <span>
      •••• <span className="text-muted">definido</span>
    </span>
  ) : (
    <span className="text-muted">não definido</span>
  );
}

export function ConnectionsPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [modalError, setModalError] = useState<unknown>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [rotating, setRotating] = useState<{ conn: AdminConnection; secrets: Secrets } | null>(
    null,
  );
  const [tests, setTests] = useState<Record<string, TestResult | 'running'>>({});
  const list = useQuery({
    queryKey: ['admin-connections'],
    queryFn: () => api.get<{ items: AdminConnection[] }>('/api/admin/connections'),
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['admin-connections'] });
    void qc.invalidateQueries({ queryKey: ['connections'] });
  };

  async function save() {
    if (!form) return;
    setModalError(null);
    const base = {
      name: form.name.trim(),
      environment: form.environment,
      mode: form.mode,
      baseUrl: form.baseUrl.trim(),
      dialect: form.dialect,
      enabled: form.enabled,
    };
    try {
      if (form.id) await api.patch(`/api/admin/connections/${form.id}`, base);
      else {
        const secrets = typedSecrets(form.secrets);
        await api.post('/api/admin/connections', {
          ...base,
          ...(Object.keys(secrets).length ? { secrets } : {}),
        });
      }
      setForm(null);
      refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function rotate() {
    if (!rotating) return;
    setModalError(null);
    try {
      await api.put(
        `/api/admin/connections/${rotating.conn.id}/secrets`,
        typedSecrets(rotating.secrets),
      );
      setRotating(null);
      refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function test(c: AdminConnection) {
    setTests((t) => ({ ...t, [c.id]: 'running' }));
    try {
      const res = await api.post<TestResult>(`/api/admin/connections/${c.id}/test`);
      setTests((t) => ({ ...t, [c.id]: res }));
    } catch (err) {
      setTests((t) => {
        const { [c.id]: _gone, ...rest } = t;
        return rest;
      });
      setError(err);
    }
  }

  async function remove(c: AdminConnection) {
    if (!window.confirm(`Excluir a conexão "${c.name}"?`)) return;
    setError(null);
    try {
      await api.del(`/api/admin/connections/${c.id}`);
      refresh();
    } catch (err) {
      setError(err);
    }
  }

  const items = list.data?.items ?? [];
  const typedCount = rotating ? Object.keys(typedSecrets(rotating.secrets)).length : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Conexões</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setModalError(null);
            setForm(EMPTY);
          }}
        >
          Nova conexão
        </button>
      </div>
      <p className="text-xs text-muted">
        Os segredos são gravados criptografados e nunca voltam para o navegador: só é possível
        substituí-los. A conexão definida por variáveis de ambiente é somente leitura e só pode ser
        testada.
      </p>
      <ErrorBox error={error ?? list.error} />
      <ul className="space-y-3">
        {items.map((c) => {
          const t = tests[c.id];
          return (
            <li
              key={c.id}
              className={`space-y-2 rounded border border-line bg-panel p-3 text-xs ${c.enabled ? '' : 'opacity-70'}`}
              data-testid="connection-item"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">{c.name}</span>
                <span className="badge" data-testid="connection-environment">
                  {ENVIRONMENT_LABEL[c.environment]}
                </span>
                <span className="badge">{c.mode}</span>
                <span className="badge">{c.dialect}</span>
                <span className="text-muted">{STATUS_LABEL[c.status]}</span>
                {!c.editable && <span className="badge text-muted">variáveis de ambiente</span>}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
                <div className="md:col-span-4">
                  <dt className="text-muted">URL base</dt>
                  <dd className="font-mono break-all">{c.baseUrl}</dd>
                </div>
                {SECRET_FIELDS.map(({ key, label }) => (
                  <div key={key}>
                    <dt className="text-muted">{label}</dt>
                    <dd data-testid={`secret-${c.id}-${key}`}>
                      {key === 'clientId' ? (
                        c.secrets.clientId === 'NOT_SET' ? (
                          <span className="text-muted">não definido</span>
                        ) : (
                          <span className="font-mono">{c.secrets.clientId}</span>
                        )
                      ) : (
                        <SecretState value={c.secrets[key]} />
                      )}
                    </dd>
                  </div>
                ))}
                <div>
                  <dt className="text-muted">Segredos rotacionados em</dt>
                  <dd>{formatDateTime(c.secretsRotatedAt)}</dd>
                </div>
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="btn"
                  disabled={t === 'running'}
                  onClick={() => void test(c)}
                >
                  Testar
                </button>
                {c.editable && (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setModalError(null);
                        setForm({ ...c, id: c.id, secrets: NO_SECRETS });
                      }}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setModalError(null);
                        setRotating({ conn: c, secrets: NO_SECRETS });
                      }}
                    >
                      Rotacionar segredos
                    </button>
                    <button type="button" className="btn" onClick={() => void remove(c)}>
                      Excluir
                    </button>
                  </>
                )}
                {t === 'running' && <span className="text-muted">Testando…</span>}
                {t && t !== 'running' && (
                  <span
                    role="status"
                    data-testid={`test-result-${c.id}`}
                    className={t.ok ? 'text-ok' : 'text-danger'}
                  >
                    {t.ok
                      ? `Conexão ok (${t.latencyMs} ms)`
                      : `Falhou${t.errorCode ? `: ${translateCode(t.errorCode)} [${t.errorCode}]` : ''}`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {!list.isPending && items.length === 0 && (
          <li className="text-center text-xs text-muted">Nenhuma conexão cadastrada.</li>
        )}
      </ul>

      <Modal
        open={form !== null}
        title={form?.id ? 'Editar conexão' : 'Nova conexão'}
        onClose={() => setForm(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!form?.name.trim() || !form?.baseUrl.trim()}
              onClick={() => void save()}
            >
              Salvar
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="space-y-1">
                <span className="block font-medium">Ambiente</span>
                <select
                  className="input"
                  value={form.environment}
                  onChange={(e) =>
                    setForm({ ...form, environment: e.target.value as ConnectionEnvironment })
                  }
                >
                  {ENVIRONMENT_OPTIONS.map((env) => (
                    <option key={env} value={env}>
                      {ENVIRONMENT_LABEL[env]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1">
                <span className="block font-medium">Modo</span>
                <select
                  className="input"
                  value={form.mode}
                  onChange={(e) => setForm({ ...form, mode: e.target.value as Form['mode'] })}
                >
                  <option value="mock">mock (dados fictícios)</option>
                  <option value="live">live (Sankhya real)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="block font-medium">Dialeto</span>
                <select
                  className="input"
                  value={form.dialect}
                  onChange={(e) => setForm({ ...form, dialect: e.target.value as Form['dialect'] })}
                >
                  <option value="oracle">Oracle</option>
                  <option value="mssql">SQL Server</option>
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="font-medium">URL base</span>
              <input
                className="input w-full font-mono"
                placeholder="https://sankhya.example.com"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              />
              Conexão habilitada
            </label>
            {form.id === null ? (
              <fieldset className="space-y-1">
                <legend className="font-medium">Segredos (opcional)</legend>
                {SECRET_FIELDS.map(({ key, label }) => (
                  <label key={key} className="block space-y-1">
                    <span>{label}</span>
                    <input
                      className="input w-full"
                      type="password"
                      autoComplete="off"
                      value={form.secrets[key]}
                      onChange={(e) =>
                        setForm({ ...form, secrets: { ...form.secrets, [key]: e.target.value } })
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="text-muted">
                Para trocar credenciais use &quot;Rotacionar segredos&quot;.
              </p>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={rotating !== null}
        title={rotating ? `Rotacionar segredos — ${rotating.conn.name}` : ''}
        onClose={() => setRotating(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setRotating(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={typedCount === 0}
              onClick={() => void rotate()}
            >
              Substituir
            </button>
          </>
        }
      >
        {rotating && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              Os valores atuais não são exibidos. Preencha apenas o que deseja substituir; campos em
              branco mantêm o valor atual.
            </p>
            {SECRET_FIELDS.map(({ key, label }) => (
              <label key={key} className="block space-y-1">
                <span className="font-medium">
                  {label}{' '}
                  <span className="font-normal text-muted">
                    (
                    {(
                      key === 'clientId'
                        ? rotating.conn.secrets.clientId !== 'NOT_SET'
                        : rotating.conn.secrets[key] === 'SET'
                    )
                      ? 'definido'
                      : 'não definido'}
                    )
                  </span>
                </span>
                <input
                  className="input w-full"
                  type="password"
                  autoComplete="off"
                  placeholder="substituir"
                  value={rotating.secrets[key]}
                  onChange={(e) =>
                    setRotating({
                      ...rotating,
                      secrets: { ...rotating.secrets, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
