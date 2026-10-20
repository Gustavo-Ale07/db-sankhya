import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AdminUser, GroupInfo, PolicyRule } from '../api/types';
import { ENVIRONMENT_LABEL } from '../components/EnvironmentBanner';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { can, useSession } from '../app/session';
import { formatDateTime } from '../lib/format';
import {
  ENVIRONMENT_OPTIONS,
  EMPTY_POLICY,
  LIMIT_FLAGS,
  formFromRule,
  policyPayload,
} from './logic';
import type { PolicyForm } from './logic';

const ACTION_OPTIONS = [
  'QUERY.SELECT',
  'TEMP.CREATE',
  'TEMP.WRITE',
  'TEMP.DROP',
  'TEMP.MATERIALIZE',
  'DATA.INSERT',
  'DATA.UPDATE',
  'DATA.DELETE',
  'DDL.CUSTOM.GENERATE',
  'SANKHYA.BUSINESS_ACTION.EXECUTE',
];

interface PolicyList {
  items: PolicyRule[];
  policyVersion: string;
  invalid: string[];
}

function toggle(list: string[], value: string, on: boolean) {
  return on ? [...list, value] : list.filter((v) => v !== value);
}

const scope = (items: string[], all = 'todos') => (items.length ? items.join(', ') : all);

export function PoliciesPage() {
  const qc = useQueryClient();
  const { user: me } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [modalError, setModalError] = useState<unknown>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; form: PolicyForm } | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const policies = useQuery({
    queryKey: ['admin-policies'],
    queryFn: () => api.get<PolicyList>('/api/admin/policies'),
  });
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: AdminUser[] }>('/api/admin/users'),
    enabled: can(me, 'ADMIN.USERS'),
  });
  const groups = useQuery({
    queryKey: ['admin-groups'],
    queryFn: () => api.get<{ items: GroupInfo[] }>('/api/admin/groups'),
    enabled: can(me, 'ADMIN.GROUPS'),
  });
  const currentVersion = version ?? policies.data?.policyVersion ?? null;
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-policies'] });

  const subjectName = (r: PolicyRule) => {
    if (r.subjectType === 'everyone') return 'todos';
    const list: { id: string; name: string }[] =
      (r.subjectType === 'user' ? users.data?.items : groups.data?.items) ?? [];
    const found = list.find((x) => x.id === r.subjectId);
    return `${r.subjectType === 'user' ? 'usuário' : 'grupo'}: ${found?.name ?? r.subjectId ?? '?'}`;
  };

  async function save() {
    if (!editing) return;
    const { body, problems: found } = policyPayload(editing.form);
    setProblems(found);
    if (!body) return;
    setModalError(null);
    try {
      const res = editing.id
        ? await api.patch<{ policyVersion: string }>(`/api/admin/policies/${editing.id}`, body)
        : await api.post<{ policyVersion: string }>('/api/admin/policies', body);
      setVersion(res.policyVersion);
      setEditing(null);
      void refresh();
    } catch (err) {
      // Server-side rule validation errors are shown as the server words them.
      setModalError(err);
    }
  }

  async function mutate(call: () => Promise<{ policyVersion: string }>) {
    setError(null);
    try {
      const res = await call();
      setVersion(res.policyVersion);
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  const open = (id: string | null, form: PolicyForm) => {
    setModalError(null);
    setProblems([]);
    setEditing({ id, form });
  };

  const f = editing?.form;
  const set = (patch: Partial<PolicyForm>) =>
    editing && setEditing({ ...editing, form: { ...editing.form, ...patch } });

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Políticas de acesso</h1>
        <button type="button" className="btn btn-primary" onClick={() => open(null, EMPTY_POLICY)}>
          Nova política
        </button>
      </div>
      <p className="text-xs text-muted">
        Regras refinam o que as permissões já concedem: nunca concedem além delas. DENY vence ALLOW.
        Ambientes, conexões, tabelas e colunas vazios significam &quot;todos&quot;; as ações são
        obrigatórias. Cada alteração gera uma nova versão do conjunto de regras.
      </p>
      {currentVersion && (
        <div className="text-xs text-muted" data-testid="policy-version">
          Versão das políticas: <span className="font-mono">{currentVersion.slice(0, 12)}</span>
        </div>
      )}
      {(policies.data?.invalid.length ?? 0) > 0 && (
        <div
          role="alert"
          className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          <div className="font-semibold">
            Há regras ativas inválidas: toda ação avaliada por política está negada até corrigi-las.
          </div>
          <ul className="list-disc pl-4">
            {policies.data!.invalid.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorBox error={error ?? policies.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="policies-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Efeito</th>
              <th>Quem</th>
              <th>Ambientes</th>
              <th>Ações</th>
              <th>Tabelas</th>
              <th>Limites</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(policies.data?.items ?? []).map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'opacity-60'}>
                <td>
                  {r.name}
                  <div className="text-[11px] text-muted">{formatDateTime(r.updatedAt)}</div>
                </td>
                <td className={r.effect === 'DENY' ? 'font-semibold text-danger' : 'text-ok'}>
                  {r.effect}
                </td>
                <td>{subjectName(r)}</td>
                <td>{scope(r.environments.map((e) => ENVIRONMENT_LABEL[e]))}</td>
                <td className="font-mono text-[11px]">{scope(r.actions)}</td>
                <td className="font-mono text-[11px]">{scope(r.entities)}</td>
                <td className="text-[11px]">
                  {Object.entries(r.limits)
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(', ') || '—'}
                </td>
                <td>{r.enabled ? 'ativa' : 'desativada'}</td>
                <td className="whitespace-nowrap">
                  <button type="button" className="btn" onClick={() => open(r.id, formFromRule(r))}>
                    Editar
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void mutate(() =>
                        api.patch(`/api/admin/policies/${r.id}`, { enabled: !r.enabled }),
                      )
                    }
                  >
                    {r.enabled ? 'Desativar' : 'Ativar'}
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (window.confirm(`Excluir a política "${r.name}"?`))
                        void mutate(() => api.del(`/api/admin/policies/${r.id}`));
                    }}
                  >
                    Excluir
                  </button>
                </td>
              </tr>
            ))}
            {!policies.isPending && (policies.data?.items.length ?? 0) === 0 && (
              <tr>
                <td colSpan={9} className="text-center text-muted">
                  Nenhuma política cadastrada.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={editing !== null}
        title={editing?.id ? 'Editar política' : 'Nova política'}
        onClose={() => setEditing(null)}
        wide
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button type="button" className="btn btn-primary" onClick={() => void save()}>
              Salvar
            </button>
          </>
        }
      >
        {f && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                maxLength={200}
                value={f.name}
                onChange={(e) => set({ name: e.target.value })}
              />
            </label>
            <div className="flex flex-wrap gap-3">
              <label className="space-y-1">
                <span className="block font-medium">Efeito</span>
                <select
                  className="input"
                  value={f.effect}
                  onChange={(e) => set({ effect: e.target.value as PolicyForm['effect'] })}
                >
                  <option value="ALLOW">ALLOW (permitir)</option>
                  <option value="DENY">DENY (negar)</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="block font-medium">Aplica-se a</span>
                <select
                  className="input"
                  value={f.subjectType}
                  onChange={(e) =>
                    set({
                      subjectType: e.target.value as PolicyForm['subjectType'],
                      subjectId: '',
                    })
                  }
                >
                  <option value="everyone">Todos</option>
                  <option value="user">Um usuário</option>
                  <option value="group">Um grupo</option>
                </select>
              </label>
              {f.subjectType !== 'everyone' && (
                <label className="space-y-1">
                  <span className="block font-medium">
                    {f.subjectType === 'user' ? 'Usuário' : 'Grupo'}
                  </span>
                  {(f.subjectType === 'user' ? users.data : groups.data) ? (
                    <select
                      className="input w-64"
                      value={f.subjectId}
                      onChange={(e) => set({ subjectId: e.target.value })}
                    >
                      <option value="">Selecione…</option>
                      {(f.subjectType === 'user'
                        ? (users.data?.items ?? []).map((u) => ({
                            id: u.id,
                            label: `${u.name} (${u.email})`,
                          }))
                        : (groups.data?.items ?? []).map((g) => ({ id: g.id, label: g.name }))
                      ).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="input w-64 font-mono"
                      placeholder="UUID"
                      value={f.subjectId}
                      onChange={(e) => set({ subjectId: e.target.value })}
                    />
                  )}
                </label>
              )}
            </div>
            <fieldset className="flex flex-wrap gap-3">
              <legend className="font-medium">Ambientes (nenhum = todos)</legend>
              {ENVIRONMENT_OPTIONS.map((env) => (
                <label key={env} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={f.environments.includes(env)}
                    onChange={(e) =>
                      set({ environments: toggle(f.environments, env, e.target.checked) })
                    }
                  />
                  {ENVIRONMENT_LABEL[env]}
                </label>
              ))}
            </fieldset>
            <fieldset className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              <legend className="font-medium">Ações (obrigatório)</legend>
              {[...new Set([...ACTION_OPTIONS, ...f.actions])].map((a) => (
                <label key={a} className="flex items-center gap-1 font-mono">
                  <input
                    type="checkbox"
                    checked={f.actions.includes(a)}
                    onChange={(e) => set({ actions: toggle(f.actions, a, e.target.checked) })}
                  />
                  {a}
                </label>
              ))}
            </fieldset>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="space-y-1">
                <span className="block font-medium">Conexões (IDs, vírgula)</span>
                <input
                  className="input w-full font-mono"
                  value={f.connectionIds}
                  onChange={(e) => set({ connectionIds: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">Tabelas (vírgula)</span>
                <input
                  className="input w-full font-mono"
                  placeholder="TGFPRO, TGFPAR"
                  value={f.entities}
                  onChange={(e) => set({ entities: e.target.value })}
                />
              </label>
              <label className="space-y-1">
                <span className="block font-medium">Colunas (vírgula)</span>
                <input
                  className="input w-full font-mono"
                  value={f.columns}
                  onChange={(e) => set({ columns: e.target.value })}
                />
              </label>
            </div>
            <fieldset className="space-y-1">
              <legend className="font-medium">Limites</legend>
              <div className="flex flex-wrap gap-3">
                <label className="space-y-1">
                  <span className="block">Máx. linhas lidas</span>
                  <input
                    className="input w-28"
                    inputMode="numeric"
                    value={f.maxReadRows}
                    onChange={(e) => set({ maxReadRows: e.target.value })}
                  />
                </label>
                <label className="space-y-1">
                  <span className="block">Máx. linhas escritas</span>
                  <input
                    className="input w-28"
                    inputMode="numeric"
                    value={f.maxWriteRows}
                    onChange={(e) => set({ maxWriteRows: e.target.value })}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {LIMIT_FLAGS.map(([key, label]) => (
                  <label key={key} className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={f[key]}
                      onChange={(e) => set({ [key]: e.target.checked })}
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={f.overrideWhereRequired}
                onChange={(e) => set({ overrideWhereRequired: e.target.checked })}
              />
              Dispensar a exigência de WHERE nesta regra
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={f.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              Regra ativa
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="list-disc pl-4 text-warn">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
