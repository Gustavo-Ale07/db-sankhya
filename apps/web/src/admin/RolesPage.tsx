import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Permission, RoleInfo } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { roleLabel, useSession } from '../app/session';

interface Form {
  id: string | null;
  key: string;
  name: string;
  description: string;
  permissions: Permission[];
  system: boolean;
}

export function RolesPage() {
  const qc = useQueryClient();
  const { user: me } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [modalError, setModalError] = useState<unknown>(null);
  const [form, setForm] = useState<Form | null>(null);
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ items: RoleInfo[]; permissions: Permission[] }>('/api/admin/roles'),
  });
  const catalog = roles.data?.permissions ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-roles'] });

  async function save() {
    if (!form) return;
    setModalError(null);
    try {
      const description = form.description.trim() || null;
      if (form.id) {
        await api.patch(`/api/admin/roles/${form.id}`, {
          name: form.name.trim(),
          description,
          // The permissions of a system role cannot change: leave them out of the patch.
          ...(form.system ? {} : { permissions: form.permissions }),
        });
      } else {
        await api.post('/api/admin/roles', {
          key: form.key.trim(),
          name: form.name.trim(),
          description,
          permissions: form.permissions,
        });
      }
      setForm(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function remove(r: RoleInfo) {
    if (!window.confirm(`Excluir o papel "${r.name}" (${r.key})?`)) return;
    setError(null);
    try {
      await api.del(`/api/admin/roles/${r.id}`);
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Papéis</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            setModalError(null);
            setForm({
              id: null,
              key: '',
              name: '',
              description: '',
              permissions: [],
              system: false,
            });
          }}
        >
          Novo papel
        </button>
      </div>
      <p className="text-xs text-muted">
        Papéis agrupam permissões. Papéis do sistema não podem ser excluídos nem ter as permissões
        alteradas. Você só concede permissões que você mesmo possui.
      </p>
      <ErrorBox error={error ?? roles.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="roles-table">
          <thead>
            <tr>
              <th>Chave</th>
              <th>Nome</th>
              <th>Permissões</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(roles.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <td className="font-mono">
                  {r.key}
                  {r.system && <span className="badge ml-1 text-muted">sistema</span>}
                </td>
                <td>
                  {r.name}
                  {r.description && <div className="text-[11px] text-muted">{r.description}</div>}
                </td>
                <td className="font-mono text-[11px]">{r.permissions.join(' · ') || '—'}</td>
                <td className="whitespace-nowrap">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setModalError(null);
                      setForm({
                        id: r.id,
                        key: r.key,
                        name: r.name,
                        description: r.description ?? '',
                        permissions: r.permissions,
                        system: r.system,
                      });
                    }}
                  >
                    Editar
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    disabled={r.system}
                    title={r.system ? 'Papéis do sistema não podem ser excluídos' : undefined}
                    onClick={() => void remove(r)}
                  >
                    Excluir
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={form !== null}
        title={form ? (form.id ? `Editar papel — ${roleLabel(form.key)}` : 'Novo papel') : ''}
        onClose={() => setForm(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setForm(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!form?.name.trim() || (!form?.id && !form?.key.trim())}
              onClick={() => void save()}
            >
              Salvar
            </button>
          </>
        }
      >
        {form && (
          <div className="space-y-2 text-xs">
            {!form.id && (
              <label className="block space-y-1">
                <span className="font-medium">Chave</span>
                <input
                  className="input w-full font-mono"
                  placeholder="EX: ANALISTA"
                  value={form.key}
                  onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
                />
                <span className="block text-[11px] text-muted">
                  Maiúsculas, números e _, começando por letra.
                </span>
              </label>
            )}
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Descrição</span>
              <input
                className="input w-full"
                maxLength={500}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </label>
            <fieldset className="space-y-1">
              <legend className="font-medium">Permissões</legend>
              {form.system && (
                <p className="text-muted">As permissões de um papel do sistema são fixas.</p>
              )}
              <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
                {catalog.map((p) => {
                  const checked = form.permissions.includes(p);
                  const held = me.permissions.includes(p);
                  return (
                    <label key={p} className="flex items-center gap-2 font-mono">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={form.system || (!checked && !held)}
                        title={!held && !checked ? 'Você não possui esta permissão' : undefined}
                        onChange={(e) =>
                          setForm({
                            ...form,
                            permissions: e.target.checked
                              ? [...form.permissions, p]
                              : form.permissions.filter((x) => x !== p),
                          })
                        }
                      />
                      {p}
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
