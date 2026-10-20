import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AdminUser, GroupInfo, Permission, RoleInfo } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { Modal } from '../components/Modal';
import { can, roleLabel, useSession } from '../app/session';

type Editing =
  | { kind: 'form'; id: string | null; name: string; description: string; active: boolean }
  | { kind: 'members'; group: GroupInfo; ids: string[] }
  | { kind: 'roles'; group: GroupInfo; keys: string[] };

/** Checkbox list; entries flagged `locked` cannot be added (still removable). */
function CheckList({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: { key: string; label: string; hint?: string; locked?: boolean }[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="max-h-72 space-y-1 overflow-auto">
      <legend className="font-medium">{legend}</legend>
      {options.map((o) => (
        <label key={o.key} className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={value.includes(o.key)}
            disabled={!value.includes(o.key) && o.locked}
            onChange={(e) =>
              onChange(e.target.checked ? [...value, o.key] : value.filter((k) => k !== o.key))
            }
          />
          <span>
            {o.label}
            {o.hint && <span className="block text-[11px] text-muted">{o.hint}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function GroupsPage() {
  const qc = useQueryClient();
  const { user: me } = useSession();
  const [error, setError] = useState<unknown>(null);
  const [modalError, setModalError] = useState<unknown>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const canMembers = can(me, 'ADMIN.USERS');
  const canRoles = can(me, 'ADMIN.ROLES');

  const groups = useQuery({
    queryKey: ['admin-groups'],
    queryFn: () => api.get<{ items: GroupInfo[] }>('/api/admin/groups'),
  });
  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: () => api.get<{ items: AdminUser[] }>('/api/admin/users'),
    enabled: canMembers,
  });
  const roles = useQuery({
    queryKey: ['admin-roles'],
    queryFn: () => api.get<{ items: RoleInfo[] }>('/api/admin/roles'),
    enabled: canRoles,
  });
  const userById = new Map((users.data?.items ?? []).map((u) => [u.id, u]));
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin-groups'] });

  const open = (e: Editing) => {
    setModalError(null);
    setEditing(e);
  };

  async function submit(call: () => Promise<unknown>) {
    setModalError(null);
    try {
      await call();
      setEditing(null);
      void refresh();
    } catch (err) {
      setModalError(err);
    }
  }

  async function quick(call: () => Promise<unknown>) {
    setError(null);
    try {
      await call();
      void refresh();
    } catch (err) {
      setError(err);
    }
  }

  const save = () => {
    if (editing?.kind !== 'form') return;
    const body = { name: editing.name.trim(), description: editing.description.trim() || null };
    return submit(() =>
      editing.id
        ? api.patch(`/api/admin/groups/${editing.id}`, { ...body, active: editing.active })
        : api.post('/api/admin/groups', body),
    );
  };

  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="flex items-center gap-2">
        <h1 className="mr-auto text-base font-semibold">Grupos</h1>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => open({ kind: 'form', id: null, name: '', description: '', active: true })}
        >
          Novo grupo
        </button>
      </div>
      <p className="text-xs text-muted">
        Grupos reúnem usuários e papéis. As permissões efetivas de um usuário somam os papéis
        diretos e os dos grupos ativos dos quais ele participa. Ninguém concede a si mesmo
        permissões que não possui, nem altera os grupos que lhe dão acesso.
      </p>
      <ErrorBox error={error ?? groups.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="groups-table">
          <thead>
            <tr>
              <th>Nome</th>
              <th>Descrição</th>
              <th>Membros</th>
              <th>Papéis</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(groups.data?.items ?? []).map((g) => (
              <tr key={g.id} className={g.active ? '' : 'opacity-60'}>
                <td>{g.name}</td>
                <td>{g.description ?? '—'}</td>
                <td>{g.memberIds.length}</td>
                <td>{g.roleKeys.length ? g.roleKeys.map(roleLabel).join(', ') : '—'}</td>
                <td>{g.active ? 'ativo' : 'inativo'}</td>
                <td className="whitespace-nowrap">
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      open({
                        kind: 'form',
                        id: g.id,
                        name: g.name,
                        description: g.description ?? '',
                        active: g.active,
                      })
                    }
                  >
                    Editar
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    disabled={!canMembers}
                    title={canMembers ? undefined : 'Listar usuários exige a permissão ADMIN.USERS'}
                    onClick={() => open({ kind: 'members', group: g, ids: g.memberIds })}
                  >
                    Membros
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    disabled={!canRoles}
                    title={canRoles ? undefined : 'Atribuir papéis exige a permissão ADMIN.ROLES'}
                    onClick={() => open({ kind: 'roles', group: g, keys: g.roleKeys })}
                  >
                    Papéis
                  </button>{' '}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (window.confirm(`Excluir o grupo "${g.name}"?`))
                        void quick(() => api.del(`/api/admin/groups/${g.id}`));
                    }}
                  >
                    Excluir
                  </button>
                </td>
              </tr>
            ))}
            {!groups.isPending && (groups.data?.items.length ?? 0) === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-muted">
                  Nenhum grupo cadastrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal
        open={editing?.kind === 'form'}
        title={editing?.kind === 'form' && editing.id ? 'Editar grupo' : 'Novo grupo'}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={editing?.kind !== 'form' || !editing.name.trim()}
              onClick={() => void save()}
            >
              Salvar
            </button>
          </>
        }
      >
        {editing?.kind === 'form' && (
          <div className="space-y-2 text-xs">
            <label className="block space-y-1">
              <span className="font-medium">Nome</span>
              <input
                className="input w-full"
                maxLength={120}
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </label>
            <label className="block space-y-1">
              <span className="font-medium">Descrição</span>
              <input
                className="input w-full"
                maxLength={500}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              />
            </label>
            {editing.id && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editing.active}
                  onChange={(e) => setEditing({ ...editing, active: e.target.checked })}
                />
                Grupo ativo
              </label>
            )}
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={editing?.kind === 'members'}
        title={editing?.kind === 'members' ? `Membros — ${editing.group.name}` : ''}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (editing?.kind !== 'members') return;
                void submit(() =>
                  api.put(`/api/admin/groups/${editing.group.id}/members`, {
                    userIds: editing.ids,
                  }),
                );
              }}
            >
              Salvar membros
            </button>
          </>
        }
      >
        {editing?.kind === 'members' && (
          <div className="space-y-2 text-xs">
            <CheckList
              legend="Usuários"
              options={[
                ...(users.data?.items ?? []).map((u) => ({
                  key: u.id,
                  label: `${u.name} (${u.email})`,
                })),
                // Members the list no longer shows (e.g. still loading) stay selected.
                ...editing.ids
                  .filter((id) => !userById.has(id))
                  .map((id) => ({ key: id, label: id })),
              ]}
              value={editing.ids}
              onChange={(ids) => setEditing({ ...editing, ids })}
            />
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>

      <Modal
        open={editing?.kind === 'roles'}
        title={editing?.kind === 'roles' ? `Papéis — ${editing.group.name}` : ''}
        onClose={() => setEditing(null)}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                if (editing?.kind !== 'roles') return;
                void submit(() =>
                  api.put(`/api/admin/groups/${editing.group.id}/roles`, { roles: editing.keys }),
                );
              }}
            >
              Salvar papéis
            </button>
          </>
        }
      >
        {editing?.kind === 'roles' && (
          <div className="space-y-2 text-xs">
            <p className="text-muted">
              Um papel com permissão que você não possui não pode ser adicionado (o servidor também
              recusa).
            </p>
            <CheckList
              legend="Papéis do grupo"
              options={(roles.data?.items ?? []).map((r) => ({
                key: r.key,
                label: roleLabel(r.key),
                hint: r.permissions.join(' · '),
                locked: r.permissions.some((p: Permission) => !me.permissions.includes(p)),
              }))}
              value={editing.keys}
              onChange={(keys) => setEditing({ ...editing, keys })}
            />
            <ErrorBox error={modalError} />
          </div>
        )}
      </Modal>
    </div>
  );
}
